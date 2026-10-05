#!/usr/bin/env bash
# verify-bun-runtime.sh — prove the daemon actually boots on the pinned bun.
#
# WHY THIS IS A SCRIPT AND NOT A TEST
#   The existing daemon tests spawn the daemon via process.execPath, so they run
#   on whatever runtime executes vitest. That is correct for a test suite and
#   useless as proof of the pin: under node those tests can all be green while
#   production runs bun. This script starts the real daemon under bun itself.
#
# WHAT IT CHECKS
#   1. the on-disk bun is exactly the version .tool-versions pins
#   2. `daemon start --foreground --listen ... --no-web-ui` boots   <- the exact
#      flags deploy/systemd/paseo.service passes (COMPAT(daemon-start-flags))
#   3. /api/health answers
#   4. every process in the chain (cli -> supervisor -> worker) is really bun,
#      read from /proc/<pid>/exe rather than inferred from the command line
#   5. SIGTERM drains the tree, releases the port and removes the PID lock
#
# It never falls back to node: a failure here is the signal, not something to
# work around.
#
# Usage: scripts/verify-bun-runtime.sh [port]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT="${1:-6971}"
BUN_VERSION_EXPECTED="$(awk '$1 == "bun" { print $2; exit }' "$REPO_ROOT/.tool-versions")"

# Refuse to run against the real deployments. paseo.service is PROD on 6767 and
# paseo-test.service is TEST on 6868; both manage live agent sessions.
case "$PORT" in
  6767 | 6868)
    echo "refusing to use deployed port $PORT (PROD is 6767, TEST is 6868)" >&2
    exit 2
    ;;
esac

# shellcheck source=./bun-runtime.sh
source "$SCRIPT_DIR/bun-runtime.sh"
paseo_assert_bun || exit 1

# Exported on purpose: without it the daemon inherits the caller's ambient
# PASEO_HOME, and on a dev box that is the real ~/.paseo -- the daemon would then
# attach to (or be refused by) the live instance instead of the scratch home.
export PASEO_HOME
PASEO_HOME="$(mktemp -d)"
OUT="$(mktemp)"
ERR="$(mktemp)"
cleanup() {
  if [ -n "${DAEMON_PID:-}" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID" 2>/dev/null || true
    sleep 5
    kill -KILL "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$PASEO_HOME" "$OUT" "$ERR"
}
trap cleanup EXIT

echo "==> bun $PASEO_REQUIRED_BUN_VERSION at $BUN_BIN"
echo "==> scratch PASEO_HOME $PASEO_HOME, port $PORT"

(
  cd "$REPO_ROOT" || exit 1
  PASEO_LISTEN="127.0.0.1:$PORT" exec "$BUN_BIN" packages/cli/dist/index.js \
    daemon start --foreground --listen "127.0.0.1:$PORT" --no-web-ui
) >"$OUT" 2>"$ERR" &
DAEMON_PID=$!

READY=0
for _ in $(seq 1 60); do
  sleep 1
  if curl -sf -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  kill -0 "$DAEMON_PID" 2>/dev/null || break
done

if [ "$READY" -ne 1 ]; then
  echo "FAIL: the daemon never became healthy under bun." >&2
  echo "---- stdout ----" >&2
  tail -40 "$OUT" >&2
  echo "---- stderr ----" >&2
  tail -40 "$ERR" >&2
  exit 1
fi
echo "==> healthy: $(curl -sf -m 5 "http://127.0.0.1:$PORT/api/health")"

SUPERVISOR_PID="$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$PASEO_HOME/paseo.pid" 2>/dev/null)"
if [ -z "$SUPERVISOR_PID" ]; then
  echo "FAIL: no PID lock at $PASEO_HOME/paseo.pid" >&2
  exit 1
fi

echo "==> process runtimes (from /proc/<pid>/exe):"
NON_BUN=0
for pid in "$DAEMON_PID" "$SUPERVISOR_PID" $(pgrep -P "$SUPERVISOR_PID" 2>/dev/null); do
  [ -d "/proc/$pid" ] || continue
  exe="$(readlink -f "/proc/$pid/exe" 2>/dev/null)"
  cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-90)"
  printf '    pid=%-8s exe=%-24s %s\n' "$pid" "$exe" "$cmd"
  case "$exe" in
    */bun) ;;
    *) NON_BUN=1 ;;
  esac
done
if [ "$NON_BUN" -ne 0 ]; then
  echo "FAIL: a daemon process is not running on bun." >&2
  exit 1
fi

echo "==> SIGTERM $DAEMON_PID"
kill -TERM "$DAEMON_PID" 2>/dev/null
DRAINED=0
for _ in $(seq 1 30); do
  sleep 1
  if ! kill -0 "$DAEMON_PID" 2>/dev/null && ! kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
    DRAINED=1
    break
  fi
done
if [ "$DRAINED" -ne 1 ]; then
  echo "FAIL: the daemon did not drain on SIGTERM." >&2
  tail -20 "$ERR" >&2
  exit 1
fi

if ss -tln 2>/dev/null | grep -q ":$PORT "; then
  echo "FAIL: port $PORT is still held after shutdown." >&2
  exit 1
fi
if [ -f "$PASEO_HOME/paseo.pid" ]; then
  echo "FAIL: the PID lock survived shutdown: $(cat "$PASEO_HOME/paseo.pid")" >&2
  exit 1
fi

echo "==> OK: booted, served, and drained cleanly on bun $BUN_VERSION_EXPECTED"
