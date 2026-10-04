#!/usr/bin/env bash
# deploy-production.sh — Build and deploy paseo to production systemd service.
# Usage: ./scripts/deploy-production.sh
#
# Hardening notes (why these steps exist — do not remove without reading):
#   - `systemctl --user stop` can hang forever when the daemon leaves D-state
#     (uninterruptible) git worktree children behind. Every stop call is wrapped
#     in `timeout` and the wait loop bounds the hang.
#   - After a crash the port can remain in LISTEN owned by no process (orphaned
#     kernel socket). Starting against that fails with EADDRINUSE and crash-loops
#     the supervisor, so we verify the port is actually free before `start`.
#   - The version stamp is idempotent AND auto-reverting: running on an
#     already-stamped tree must not append the hash again, and the tracked
#     package.json must end the deploy back at its committed version so the
#     never carries a dirty diff or accumulated suffixes.
#   - Full output is teed to deploy-production.log so an interrupted background
#     run is recoverable from the log instead of leaving the daemon half-restarted.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_UI_SRC="$REPO_ROOT/packages/app/dist"
WEB_UI_DEST="$REPO_ROOT/packages/server/dist/server/web-ui"
PORT=6767
LOG_FILE="$REPO_ROOT/deploy-production.log"
XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export XDG_RUNTIME_DIR

# One deploy at a time. Two overlapping runs would interleave stop/restart on
# the same systemd unit and the loser would leave the daemon down. `set -o
# noclobber` makes the redirect atomic, so the lock is a file holding a PID
# rather than a directory (a directory is not empty once the PID is written in
# it, so rmdir could never release it).
DEPLOY_LOCK="$REPO_ROOT/.deploy-production.lock"
if ! (set -o noclobber; echo $$ > "$DEPLOY_LOCK") 2>/dev/null; then
  holder=$(cat "$DEPLOY_LOCK" 2>/dev/null || echo "")
  # A SIGKILL, an OOM or a hard reboot skips the EXIT trap, so the lock can
  # outlive its holder. Two conditions must both hold before reclaiming, and
  # neither is sufficient alone:
  #   - the holder is not a live deploy. `kill -0` alone is not enough because
  #     PIDs get recycled; the cmdline is a second check, but it is brittle on
  #     its own (a copy or a differently-named invocation would read as "not a
  #     deploy" and get its lock stolen mid-run).
  #   - the lock is old. A running deploy refreshes nothing, but it was written
  #     when it started, so a fresh mtime means someone is deploying right now.
  # Both together cannot steal a lock from a live overlapping run.
  # 15 min: long enough that any in-flight deploy still holds a fresh lock,
  # short enough that a crashed deploy does not block the next one for long.
  stale_after=${PASEO_DEPLOY_LOCK_STALE_SECONDS:-900}
  lock_age=$(( $(date +%s) - $(stat -c %Y "$DEPLOY_LOCK" 2>/dev/null || echo 0) ))
  holder_is_deploy=false
  if [[ "$holder" =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null &&
    grep -qa deploy-production "/proc/$holder/cmdline" 2>/dev/null; then
    holder_is_deploy=true
  fi
  if [[ "$holder_is_deploy" == false && "$lock_age" -ge "$stale_after" ]]; then
    printf 'Reclaiming stale deploy lock from dead pid %s\n' "$holder"
    rm -f "$DEPLOY_LOCK"
    (set -o noclobber; echo $$ > "$DEPLOY_LOCK") 2>/dev/null || {
      printf 'ERROR: lost the race for %s\n' "$DEPLOY_LOCK" >&2
      exit 1
    }
  else
    printf 'ERROR: another deploy holds %s (pid %s).\n' "$DEPLOY_LOCK" "${holder:-unknown}" >&2
    exit 1
  fi
fi
release_deploy_lock() { rm -f "$DEPLOY_LOCK"; }

# Tee all output so a killed background job still leaves a full log behind.
exec > >(tee "$LOG_FILE") 2>&1

say()  { printf '%s\n' "$*"; }
fail() { say "ERROR: $*"; exit 1; }

# Read the whole output before matching. Piping straight into `grep -q` exits
# the match as soon as it finds LISTEN, the writer then dies on SIGPIPE, and
# `set -o pipefail` reports that as "not listening" — so a held port (exactly
# the orphaned-socket case this guards) reads as free.
port_listening() {
  local sockets
  sockets=$(ss -tln "sport = :$PORT" 2>/dev/null || true)
  [[ "$sockets" == *LISTEN* ]]
}

daemon_running() {
  # The unit launches paseo-bun, which execs
  #   bun <runtime>/@getpaseo/cli/dist/index.js daemon start --foreground ...
  # The old "paseo daemon start" pattern matched none of that — the CLI entry
  # sits between "paseo" and "daemon start" — so this check silently reported
  # "stopped" while the daemon was still up, and wait_for_daemon_exit degraded
  # to waiting on the port alone. Match the argument run every layout shares.
  pgrep -f 'paseo.*daemon start' >/dev/null 2>&1
}

# Wait until no daemon process exists and the port is released.
# Returns 0 if cleared, 1 if stuck processes remain after the timeout.
wait_for_daemon_exit() {
  local i
  for i in $(seq 1 30); do
    if ! daemon_running && ! port_listening; then
      return 0
    fi
    sleep 1
  done
  return 1
}

stop_service() {
  say "  Stopping paseo..."
  # Never let systemd block forever on D-state children. stop returns as soon as
  # the stop job is queued; the wait loop below does the real polling.
  timeout 20 systemctl --user stop paseo 2>/dev/null || true
  timeout 10 systemctl --user kill --signal=SIGTERM paseo 2>/dev/null || true
  sleep 1
  timeout 10 systemctl --user kill --signal=SIGKILL paseo 2>/dev/null || true
  sleep 1
}

start_service() {
  # No pid-file removal here. PASEO_HOME moved to ~/paseo/PROD, so the old
  # $HOME/.paseo/paseo.pid never existed and the line did nothing; and deleting
  # the real one blindly would drop the lock of a daemon that is still alive.
  # The unit's ExecStartPre (paseo-prestart.sh) already clears $PASEO_PID_FILE,
  # and only when the recorded PID is dead or is not a Paseo process.
  timeout 20 systemctl --user reset-failed paseo 2>/dev/null || true
  say "  Starting paseo..."
  if ! timeout 30 systemctl --user start paseo; then
    fail "systemctl --user start paseo failed — see journalctl --user -u paseo"
  fi
}

wait_for_health() {
  local attempts=30 i
  for i in $(seq 1 "$attempts"); do
    if curl -sf --max-time 3 http://127.0.0.1:$PORT/api/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

say "=== Paseo Production Deploy ==="
say "Repo: $REPO_ROOT"
say "Log:  $LOG_FILE"

# ---------------------------------------------------------------------------
# [0/6] Version stamp: transient, idempotent, always reverted
# ---------------------------------------------------------------------------
# The stamped version is metadata the daemon reads at runtime; it is NOT a
# source change. Snapshot every file the stamp touches before writing, and
# restore that snapshot on ANY exit — a failed build must not leave the tree
# dirty, and a re-run must not stack another suffix.
say ""
say "[0/6] Stamping version with commit hash..."
cd "$REPO_ROOT"
SHORT_HASH=$(git rev-parse --short HEAD)
COMMITTED_VERSION=$(git show HEAD:package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
CURRENT_VERSION=$(node -p "require('./package.json').version")
STAMPED_VERSION="$CURRENT_VERSION"

# The workspace list is the same one sync-workspace-versions.mjs walks, so the
# snapshot covers every file that step can rewrite.
STAMP_BACKUP_DIR=$(mktemp -d)
mapfile -t STAMP_TARGETS < <(
  node -e "const p=require('./package.json');console.log(['package.json',...(p.workspaces||[]).map((w)=>w+'/package.json')].join('\n'))"
)
for f in "${STAMP_TARGETS[@]}"; do
  [ -f "$f" ] || continue
  mkdir -p "$STAMP_BACKUP_DIR/$(dirname "$f")"
  cp "$f" "$STAMP_BACKUP_DIR/$f"
done

restore_stamp() {
  local status=$?
  release_deploy_lock
  for f in "${STAMP_TARGETS[@]}"; do
    [ -f "$STAMP_BACKUP_DIR/$f" ] && cp "$STAMP_BACKUP_DIR/$f" "$f"
  done
  rm -rf "$STAMP_BACKUP_DIR"
  return $status
}
trap 'restore_stamp; release_deploy_lock' EXIT

if [[ "$CURRENT_VERSION" == *"-$SHORT_HASH" ]]; then
  say "  Version already stamped ($CURRENT_VERSION) — skipping"
else
  STAMPED_VERSION="${COMMITTED_VERSION}-${SHORT_HASH}"
  say "  Version: $CURRENT_VERSION -> $STAMPED_VERSION"
  node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$STAMPED_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
  node scripts/sync-workspace-versions.mjs
fi

# ---------------------------------------------------------------------------
# [1/6] Install deps (pnpm — the repo declares packageManager pnpm)
# ---------------------------------------------------------------------------
say ""
say "[1/6] Installing dependencies (pnpm install --frozen-lockfile)..."
pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# [2/6] Build server and web app only (skip desktop/mobile)
# ---------------------------------------------------------------------------
say ""
say "[2/6] Building server and web app..."
pnpm --filter @getpaseo/highlight run build
pnpm --filter @getpaseo/relay run build
pnpm --filter @getpaseo/protocol run build
pnpm --filter @getpaseo/client run build
pnpm --filter @getpaseo/server run build
pnpm --filter @getpaseo/cli run build

# ---------------------------------------------------------------------------
# [3/6] Build the web app (expo export)
# ---------------------------------------------------------------------------
say ""
say "[3/6] Building web app..."
cd "$REPO_ROOT/packages/app"
pnpm --filter @getpaseo/app run build:web
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# [4/6] Copy web UI dist to server location
# ---------------------------------------------------------------------------
say ""
say "[4/6] Copying web UI dist to server..."
rm -rf "$WEB_UI_DEST"
mkdir -p "$WEB_UI_DEST"
# Copy the CONTENTS of the source dir (trailing /.). cp -r src dst with an
# existing dst would nest the src basename (web-ui/dist/) and break the daemon's
# static file serving, which expects index.html directly under web-ui/.
cp -r "$WEB_UI_SRC/." "$WEB_UI_DEST/"
say "  Copied: $WEB_UI_SRC -> $WEB_UI_DEST"
ls "$WEB_UI_DEST" | head -5

# ---------------------------------------------------------------------------
# [5/6] Restart service (bounded stop → verify free → start)
# ---------------------------------------------------------------------------
say ""
say "[5/6] Restarting paseo systemd service..."

stop_service

if ! wait_for_daemon_exit; then
  say "  WARNING: processes still running after 30s."
  ps -eo pid,stat,comm,args | awk '$2 ~ /^[DXZ]/ && ($0 ~ /paseo/ || $0 ~ /git.*worktree/)' || true
  # D-state (uninterruptible) processes cannot be killed and block the cgroup.
  if ps -eo pid,stat | grep -q ' D '; then
    say "  D-state processes found. These only clear on reboot."
  fi
  fail "old daemon did not exit. Reboot the host, or if the port is orphaned run: sudo ss --kill state listening sport = :$PORT"
fi
say "  Old process exited"

if port_listening; then
  say "  Port :$PORT still LISTEN but no daemon process is alive (orphaned kernel socket)."
  fail "run: sudo ss --kill state listening sport = :$PORT  (then re-run this script)"
fi
say "  Port :$PORT free"

start_service

# ---------------------------------------------------------------------------
# [6/6] Verify health (with retries)
# ---------------------------------------------------------------------------
say ""
say "[6/6] Verifying health..."
if ! wait_for_health; then
  say "  Health endpoint did not respond within 60s"
  HEALTH='{"status":"error"}'
  HTTP_CODE=000
else
  HEALTH=$(curl -sf --max-time 3 http://127.0.0.1:$PORT/api/health 2>/dev/null || echo '{"status":"error"}')
  HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:$PORT/ 2>/dev/null || echo "000")
fi

say ""
say "=== Deploy Complete ==="
say "Version: $STAMPED_VERSION"
say "Health: $HEALTH"
say "Web UI HTTP: $HTTP_CODE"

# Revert the transient version stamp so the deployment never leaves the tracked
# package.json dirty (review finding #8 on PR #38) and re-running never doubles
# the suffix ("0.9.2-<hash1>-<hash2>-...").
# The EXIT trap restores the pre-stamp snapshot of every touched file, so the
# tree ends clean on success and on failure alike.
say ""
say "Version stamp will be reverted on exit (trap)."

if [ "$HTTP_CODE" = "200" ]; then
  say "Status: OK"
else
  say "Status: WARNING — Web UI returned HTTP $HTTP_CODE"
  exit 1
fi
