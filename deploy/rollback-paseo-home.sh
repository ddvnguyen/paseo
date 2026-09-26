#!/usr/bin/env bash
# rollback-paseo-home.sh — reverse consolidate-paseo-home.sh.
#
# Restores the pre-consolidation layout:
#   $HOME/.paseo-test, $HOME/.paseo, $HOME/paseo-PROD, $HOME/paseo-prod-bun,
#   $HOME/paseo-app, $HOME/paseo-builds
# and the backed-up systemd units / runner .env.
#
# NOT restorable (caches, re-derivable): the legacy pnpm store and bun cache
# deleted by the consolidation. Everything else is restored by `mv`.
#
# Usage:
#   deploy/rollback-paseo-home.sh [--dry-run] [--yes] [--backup-dir DIR]
#                                 [--skip-restart]
set -euo pipefail

ROOT="${PASEO_ROOT:-$HOME/paseo}"

PROD_HOME_OLD="$HOME/.paseo"
TEST_HOME_OLD="$HOME/.paseo-test"
PROD_RT_OLD="$HOME/paseo-PROD"
PROD_BUN_OLD="$HOME/paseo-prod-bun"
APP_OLD="$HOME/paseo-app"
BUILDS_OLD="$HOME/paseo-builds"

UNIT_DST="$HOME/.config/systemd/user"
RUNNER_ENV="$HOME/actions-runners/paseo/.env"

DRY_RUN=0
ASSUME_YES=0
SKIP_RESTART=0
BACKUP_DIR=""

log()  { printf '[rollback] %s\n' "$*"; }
warn() { printf '[rollback][warn] %s\n' "$*" >&2; }
die()  { printf '[rollback][error] %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY_RUN" -eq 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }

move_if() {
  local src="$1" dst="$2"
  if [ ! -e "$src" ]; then log "skip (absent): $src"; return 0; fi
  if [ -e "$dst" ]; then log "skip (already restored): $src -> $dst"; return 0; fi
  log "restore: $src -> $dst"
  run mkdir -p "$(dirname "$dst")"
  run mv "$src" "$dst"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)      DRY_RUN=1 ;;
    --yes|-y)       ASSUME_YES=1 ;;
    --skip-restart) SKIP_RESTART=1 ;;
    --backup-dir)   shift; BACKUP_DIR="${1:?--backup-dir needs a path}" ;;
    -h|--help)      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

if [ "$ASSUME_YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  printf '\nThis will reverse the paseo consolidation under %s. Continue? [y/N] ' "$ROOT"
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) die "aborted by user" ;; esac
fi

[ -d "$ROOT" ] || die "consolidated root not found: $ROOT"

if [ -z "$BACKUP_DIR" ]; then
  BACKUP_DIR="$(ls -1dt "$ROOT"/.backup-* 2>/dev/null | head -1 || true)"
fi

# ── Split PROD runtime back out, then restore home state ───────────────────
if [ -d "$ROOT/PROD" ]; then
  run mkdir -p "$PROD_RT_OLD"
  for item in node_modules package.json pnpm-lock.yaml bun.lock package-lock.json package.json.bak paseo-bun; do
    [ -e "$ROOT/PROD/$item" ] || continue
    log "split runtime: $ROOT/PROD/$item -> $PROD_RT_OLD/$item"
    run mv "$ROOT/PROD/$item" "$PROD_RT_OLD/$item"
  done
fi

move_if "$ROOT/TEST" "$TEST_HOME_OLD"
move_if "$ROOT/PROD" "$PROD_HOME_OLD"
move_if "$ROOT/app" "$APP_OLD"
move_if "$ROOT/builds" "$BUILDS_OLD"

# Recreate the hardlink clone the PROD launcher historically pointed at.
if [ -d "$PROD_RT_OLD" ] && [ ! -d "$PROD_BUN_OLD" ]; then
  log "recreate runtime clone: cp -al $PROD_RT_OLD $PROD_BUN_OLD"
  run cp -al "$PROD_RT_OLD" "$PROD_BUN_OLD"
fi

# ── Restore units + runner env from backup ─────────────────────────────────
if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
  log "restoring systemd units from $BACKUP_DIR"
  for bak in "$BACKUP_DIR"/*.bak; do
    [ -e "$bak" ] || continue
    name="$(basename "$bak" .bak)"
    log "restore unit: $name"
    run cp -f "$bak" "$UNIT_DST/$name"
  done
  run systemctl --user daemon-reload
else
  warn "no backup dir found — restore units manually (see git history of deploy/systemd/)"
fi

# ── Restart ────────────────────────────────────────────────────────────────
if [ "$SKIP_RESTART" -eq 1 ]; then
  log "restart skipped (--skip-restart)"
  exit 0
fi
log "restart paseo-test"
run systemctl --user restart paseo-test.service
log "restart paseo-app"
run systemctl --user restart paseo-app.service
log "restart paseo (PROD)"
run systemctl --user restart paseo.service
log "rollback done"
