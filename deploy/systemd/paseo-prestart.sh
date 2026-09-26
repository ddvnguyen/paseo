#!/usr/bin/env bash
# paseo-prestart.sh — systemd user ExecStartPre for the paseo daemons.
#
# Parameterised by environment (set in the unit) so the same script serves
# both the PROD (:6767) and TEST (:6868) instances:
#   PASEO_PRESTART_PORT  (required) — TCP port this instance listens on
#   PASEO_PID_FILE       (optional) — defaults to $HOME/.paseo/paseo.pid
#
# Why this exists: after an unclean shutdown (SIGKILL from a timed-out stop),
# a stale Paseo Daemon process can survive in the cgroup and keep the port in
# LISTEN. The next start then fails with EADDRINUSE and the supervisor
# crash-loops ("Daemon failed to start listening").
#
# SECOND failure mode: the daemon writes $PASEO_HOME/paseo.pid and, on startup,
# refuses to run if it believes another instance is alive. Its liveness check
# is a bare `kill -0 <pid>`, which PID reuse can fool — when the old daemon
# dies without removing its pid file, the kernel can recycle that PID for an
# unrelated process. We clear the pid file when it is (a) dead, or (b) alive
# but NOT a Paseo process. We never touch a pid file that genuinely belongs to
# a live Paseo daemon.
#
# It only ever touches the configured port and pid file, so the PROD and TEST
# instances can never interfere with each other.
set -u

PORT="${PASEO_PRESTART_PORT:?PASEO_PRESTART_PORT must be set}"
PIDFILE="${PASEO_PID_FILE:-$HOME/.paseo/paseo.pid}"

log() { printf 'paseo-prestart: %s\n' "$*"; }

# True if PID is a live Paseo daemon (not a recycled unrelated process).
# Paseo renames its threads to "Paseo Supervisor"/"Paseo Daemon" (capital P),
# so the match is case-insensitive and also covers the node launcher's
# "paseo daemon start" cmdline and the paseo binary path.
is_paseo_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local info
  info="$(tr '\0' ' ' < /proc/"$pid"/cmdline 2>/dev/null) $(readlink /proc/"$pid"/exe 2>/dev/null) $(cat /proc/"$pid"/comm 2>/dev/null)"
  case "$(printf '%s' "$info" | tr '[:upper:]' '[:lower:]')" in
    *paseo*) return 0 ;;
    *) return 1 ;;
  esac
}

# Remove a stale pid file: missing → nothing to do; dead PID → stale;
# alive-but-not-Paseo → stale (PID reuse). Live Paseo → leave it alone.
clear_stale_pidfile() {
  [ -f "$PIDFILE" ] || return 0
  local pid
  pid="$(grep -oE '"pid":[0-9]+' "$PIDFILE" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
  if [ -z "$pid" ]; then
    log "pid file $PIDFILE has no parseable pid; removing"
    rm -f "$PIDFILE" || true
    return 0
  fi
  if kill -0 "$pid" 2>/dev/null; then
    if is_paseo_pid "$pid"; then
      log "pid file references a live Paseo daemon (PID $pid); leaving it"
      return 0
    fi
    log "pid file references PID $pid which is NOT Paseo (recycled); clearing stale lock"
  else
    log "pid file references dead PID $pid; clearing stale lock"
  fi
  rm -f "$PIDFILE" || true
}

clear_stale_pidfile

# PID(s) currently listening on our port, one per line (blank if none).
port_owner_pids() {
  ss -tlnp "sport = :$PORT" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
}

# Kill a stale process that owns the port. A process owning our port is, by
# construction, either a leftover from a previous paseo run or a rogue holder —
# never something we should preserve.
kill_stale_owner() {
  local pid
  for pid in $(port_owner_pids); do
    if ! kill -0 "$pid" 2>/dev/null; then
      continue
    fi
    log "stale process $pid holds port $PORT; terminating (SIGTERM)"
    kill "$pid" 2>/dev/null || true
  done
}

# Wait until the port is released, escalating to SIGKILL for stubborn owners.
# Returns 0 on success, 1 if the port is still busy or orphaned.
wait_port_free() {
  local i pid
  for i in $(seq 1 10); do
    pids="$(port_owner_pids)"
    if [ -z "$pids" ]; then
      return 0
    fi
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then
        log "stale process $pid still alive; SIGKILL"
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
    sleep 1
  done
  return 1
}

log "checking port $PORT before start"

if [ -z "$(port_owner_pids)" ]; then
  log "port $PORT free"
  exit 0
fi

log "port $PORT busy — cleaning up stale holder(s)"
kill_stale_owner

if wait_port_free; then
  log "port $PORT released"
  exit 0
fi

# We get here only if the port is still busy after SIGKILL.
if ss -tln "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
  if [ -z "$(port_owner_pids)" ]; then
    # A LISTEN socket with no owning process is an orphaned kernel socket.
    # Only root can reap it; fail loudly and tell the operator exactly what to run.
    echo "ERROR: port $PORT is an orphaned kernel socket (no owning process)." >&2
    echo "ERROR: run 'sudo ss --kill state listening sport = :$PORT' and restart paseo." >&2
  else
    echo "ERROR: port $PORT still held by a D-state (uninterruptible) process." >&2
    echo "ERROR: D-state processes only clear on reboot." >&2
  fi
  exit 1
fi

log "port $PORT released"
exit 0
