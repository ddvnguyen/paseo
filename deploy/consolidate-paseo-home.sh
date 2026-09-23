#!/usr/bin/env bash
# consolidate-paseo-home.sh — migrate the paseo host layout into a single root
# folder ($HOME/paseo) with consistent PROD/TEST naming, and reclaim duplicate
# node_modules / pnpm-store / bun-cache disk.
#
# Design goals:
#   * Idempotent — safe to re-run; each step is skipped if already done.
#   * Reversible — every relocation is a same-filesystem `mv` (rename); the
#     companion rollback-paseo-home.sh reverses it. Only the legacy pnpm store
#     and the bun download cache are deleted (both are caches, re-derivable).
#   * Zero-surprise — `--dry-run` prints the plan without touching anything;
#     `--yes` skips the interactive confirmation.
#
# Layout produced (all under $HOME/paseo):
#   PROD/   PASEO_HOME + runtime (node_modules, package.json, paseo-bun, ...)
#   TEST/   PASEO_HOME + runtime
#   app/    Caddyfile + web-ui (+ test-branding/)
#   builds/ android, artifacts, hydra
#   dev/    placeholder; the dev checkout lives in the workspace submodule
#
# Usage:
#   deploy/consolidate-paseo-home.sh [--dry-run] [--yes] [--reclaim-only]
#                                    [--skip-reclaim] [--skip-restart]
#                                    [--move-dev] [--dev-target PATH]
#
# Exit codes: 0 ok, 1 error, 2 usage error.
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────
ROOT="${PASEO_ROOT:-$HOME/paseo}"

PROD_HOME_OLD="$HOME/.paseo"          # PROD PASEO_HOME (+ stale node_modules)
TEST_HOME_OLD="$HOME/.paseo-test"     # TEST PASEO_HOME + runtime
PROD_RT_OLD="$HOME/paseo-PROD"        # PROD runtime install target
PROD_BUN_OLD="$HOME/paseo-prod-bun"   # PROD runtime hardlink clone (dropped)
APP_OLD="$HOME/paseo-app"             # Caddy + web-ui
BUILDS_OLD="$HOME/paseo-builds"       # CI artifacts
DEV_OLD="$HOME/paseo-fresh"           # dev checkout
BRANDING_OLD="$HOME/.paseo-test-branding"

LEGACY_STORE="$HOME/.local/share/pnpm/store"
ACTIVE_STORE="$HOME/.pnpm-store"
BUN_CACHE="$HOME/.bun/install/cache"

DEV_TARGET_DEFAULT="/mnt/WorkDisk/Workplace/llm-server-monitoring/external/paseo"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SRC="$SCRIPT_DIR/systemd"
UNIT_DST="$HOME/.config/systemd/user"
RUNNER_ENV="$HOME/actions-runners/paseo/.env"

DRY_RUN=0
ASSUME_YES=0
RECLAIM_ONLY=0
SKIP_RECLAIM=0
SKIP_RESTART=0
MOVE_DEV=0
DEV_TARGET="$DEV_TARGET_DEFAULT"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR=""

# ── Helpers ────────────────────────────────────────────────────────────────
log()  { printf '[consolidate] %s\n' "$*"; }
warn() { printf '[consolidate][warn] %s\n' "$*" >&2; }
die()  { printf '[consolidate][error] %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# move_if SRC DST — rename SRC to DST if SRC exists and DST does not.
move_if() {
  local src="$1" dst="$2"
  if [ ! -e "$src" ]; then
    log "skip (absent): $src"
    return 0
  fi
  if [ -e "$dst" ]; then
    log "skip (already migrated): $src -> $dst"
    return 0
  fi
  log "move: $src -> $dst"
  run mkdir -p "$(dirname "$dst")"
  run mv "$src" "$dst"
}

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

# ── Argument parsing ───────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)        DRY_RUN=1 ;;
    --yes|-y)         ASSUME_YES=1 ;;
    --reclaim-only)   RECLAIM_ONLY=1 ;;
    --skip-reclaim)   SKIP_RECLAIM=1 ;;
    --skip-restart)   SKIP_RESTART=1 ;;
    --move-dev)       MOVE_DEV=1 ;;
    --dev-target)     shift; DEV_TARGET="${1:?--dev-target needs a path}" ;;
    -h|--help)        usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# ── Preflight ──────────────────────────────────────────────────────────────
preflight() {
  log "preflight"
  command -v mv >/dev/null || die "mv not found"
  command -v systemctl >/dev/null || die "systemctl not found"
  [ -d "$HOME" ] || die "HOME is not a directory: $HOME"

  if [ -d "$ROOT" ] && [ -d "$ROOT/PROD" ] && [ -d "$ROOT/TEST" ]; then
    log "root $ROOT already present (migration likely done)"
  fi

  # Refuse to run the destructive parts without confirmation.
  if [ "$ASSUME_YES" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    printf '\nThis will relocate paseo directories under %s and DELETE caches.\n' "$ROOT"
    printf 'Continue? [y/N] '
    read -r reply
    case "$reply" in
      y|Y|yes|YES) ;;
      *) die "aborted by user" ;;
    esac
  fi

  BACKUP_DIR="$ROOT/.backup-$STAMP"
  if [ "$DRY_RUN" -eq 0 ]; then
    mkdir -p "$BACKUP_DIR"
    log "backups -> $BACKUP_DIR"
  fi
}

backup_file() {
  local f="$1"
  [ -e "$f" ] || return 0
  [ -n "$BACKUP_DIR" ] || return 0
  run cp -a "$f" "$BACKUP_DIR/$(basename "$f").bak"
}

# ── Phase 0: reclaim ───────────────────────────────────────────────────────
phase_reclaim() {
  log "── phase 0: reclaim caches / stale trees ──"

  # Legacy pnpm store: only safe once pnpm's configured store is the active one.
  if [ -d "$LEGACY_STORE" ]; then
    local configured
    configured="$(pnpm config get store-dir 2>/dev/null || true)"
    case "$configured" in
      *".pnpm-store"*)
        log "remove legacy pnpm store (configured store is $configured): $LEGACY_STORE"
        run rm -rf "$LEGACY_STORE"
        ;;
      *)
        warn "pnpm store-dir is '$configured' (not .pnpm-store) — NOT removing $LEGACY_STORE"
        ;;
    esac
  else
    log "skip (absent): $LEGACY_STORE"
  fi

  # Bun download cache (re-downloadable; does not change the bun version).
  if [ -d "$BUN_CACHE" ]; then
    log "remove bun install cache: $BUN_CACHE"
    run rm -rf "$BUN_CACHE"
  else
    log "skip (absent): $BUN_CACHE"
  fi

  # Stale PROD home node_modules: the flat (non-pnpm) install left over from the
  # pre-split scheme. Guard on the absence of a .pnpm dir so we never touch a
  # real pnpm tree.
  if [ -d "$PROD_HOME_OLD/node_modules" ] && [ ! -d "$PROD_HOME_OLD/node_modules/.pnpm" ]; then
    log "remove stale flat node_modules: $PROD_HOME_OLD/node_modules"
    run rm -rf "$PROD_HOME_OLD/node_modules"
  elif [ -d "$PROD_HOME_OLD/node_modules" ]; then
    warn "keeping $PROD_HOME_OLD/node_modules (has .pnpm — not the stale flat tree)"
  fi

  # Transient dirs / oversized old logs.
  local d
  for d in "$HOME"/paseo-classify-home-*; do
    [ -e "$d" ] || continue
    log "remove transient: $d"
    run rm -rf "$d"
  done

  if [ -d "$ACTIVE_STORE" ]; then
    log "prune active pnpm store: $ACTIVE_STORE"
    run pnpm store prune
  fi
}

# ── Phase 1: dev checkout ──────────────────────────────────────────────────
phase_dev() {
  log "── phase 1: dev checkout ──"
  run mkdir -p "$ROOT/dev"

  if [ "$MOVE_DEV" -ne 1 ]; then
    log "dev move not requested (pass --move-dev to relocate $DEV_OLD)"
    return 0
  fi

  if [ ! -d "$DEV_OLD" ]; then
    log "skip (absent): $DEV_OLD"
    return 0
  fi

  # Safety: never delete an unpushed or dirty checkout.
  if [ -n "$(git -C "$DEV_OLD" status --porcelain 2>/dev/null)" ]; then
    die "$DEV_OLD has uncommitted changes — commit/push them before --move-dev"
  fi
  local branch
  while IFS= read -r branch; do
    [ -n "$branch" ] || continue
    if ! git -C "$DEV_OLD" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
      die "branch '$branch' is not on origin — push it before --move-dev"
    fi
  done < <(git -C "$DEV_OLD" for-each-ref --format='%(refname:short)' refs/heads)

  log "dev branches are pushed to origin — safe to relocate"

  if [ -d "$DEV_TARGET" ] && git -C "$DEV_TARGET" rev-parse --git-dir >/dev/null 2>&1; then
    log "fetching into dev target: $DEV_TARGET"
    run git -C "$DEV_TARGET" fetch origin --quiet || true
    log "target ready — switch with: git -C '$DEV_TARGET' switch <branch>"
  else
    warn "dev target $DEV_TARGET is not a usable git checkout"
    warn "after removal, re-clone: git clone https://github.com/ddvnguyen/paseo.git '$DEV_TARGET'"
  fi

  log "remove dev checkout: $DEV_OLD (branches preserved on origin)"
  run rm -rf "$DEV_OLD"

  if [ "$DRY_RUN" -eq 0 ]; then
    cat > "$ROOT/dev/README.md" <<EOF
# Paseo dev checkout

The dev working tree lives in the workspace submodule:

    $DEV_TARGET

(freed from $DEV_OLD on $STAMP; branches preserved on origin)
EOF
  fi
}

# ── Phase 2: consolidate runtime dirs ──────────────────────────────────────
phase_consolidate() {
  log "── phase 2: consolidate into $ROOT ──"

  # Stop the daemons before moving their trees so no process keeps a stale
  # absolute path to a renamed/deleted directory. Skipped under --skip-restart
  # (operator owns the service lifecycle then) and under --dry-run.
  if [ "$SKIP_RESTART" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    local unit
    for unit in paseo.service paseo-test.service paseo-app.service; do
      if systemctl --user is-active --quiet "$unit"; then
        log "stop $unit"
        systemctl --user stop "$unit" || warn "failed to stop $unit"
      fi
    done
  fi

  run mkdir -p "$ROOT"

  move_if "$TEST_HOME_OLD" "$ROOT/TEST"
  move_if "$PROD_HOME_OLD" "$ROOT/PROD"

  # Merge the PROD runtime tree into PROD/ (which is the renamed PASEO_HOME).
  if [ -d "$PROD_RT_OLD" ] && [ -d "$ROOT/PROD" ]; then
    local item
    for item in node_modules package.json pnpm-lock.yaml bun.lock package-lock.json package.json.bak; do
      [ -e "$PROD_RT_OLD/$item" ] || continue
      if [ -e "$ROOT/PROD/$item" ]; then
        warn "PROD/$item already exists — leaving $PROD_RT_OLD/$item in place"
      else
        log "merge: $PROD_RT_OLD/$item -> $ROOT/PROD/$item"
        run mv "$PROD_RT_OLD/$item" "$ROOT/PROD/$item"
      fi
    done
    # The runtime launcher is authoritative — overwrite any stale home wrapper.
    if [ -e "$PROD_RT_OLD/paseo-bun" ]; then
      log "install runtime launcher: $ROOT/PROD/paseo-bun"
      run cp -f "$PROD_RT_OLD/paseo-bun" "$ROOT/PROD/paseo-bun"
      run chmod +x "$ROOT/PROD/paseo-bun"
    fi
  fi

  move_if "$APP_OLD" "$ROOT/app"
  move_if "$BUILDS_OLD" "$ROOT/builds"
  if [ -d "$BRANDING_OLD" ]; then
    move_if "$BRANDING_OLD" "$ROOT/app/test-branding"
  fi

  # Drop the redundant PROD dirs (paseo-prod-bun is a hardlink clone).
  if [ -d "$PROD_RT_OLD" ]; then
    log "remove leftover install target: $PROD_RT_OLD"
    run rm -rf "$PROD_RT_OLD"
  fi
  if [ -d "$PROD_BUN_OLD" ]; then
    log "remove redundant runtime clone: $PROD_BUN_OLD"
    run rm -rf "$PROD_BUN_OLD"
  fi

  # Rewrite the PROD launcher to point at the consolidated tree.
  if [ "$DRY_RUN" -eq 0 ] && [ -d "$ROOT/PROD" ]; then
    cat > "$ROOT/PROD/paseo-bun" <<'EOF'
#!/usr/bin/env bash
# Run the PROD paseo instance under bun 1.4.x with PASEO_HOME=~/.paseo.
# Consolidated layout (2026-09): runtime + home both live in ~/paseo/PROD.
set -euo pipefail

PROD_ROOT="$HOME/paseo/PROD"
PKG="$PROD_ROOT/node_modules/@getpaseo/cli"
DIST="$PKG/dist/index.js"

export PASEO_HOME="${PASEO_HOME:-$PROD_ROOT}"
mkdir -p "$PASEO_HOME"

export PASEO_LISTEN="${PASEO_LISTEN:-0.0.0.0:6767}"
export PASEO_HOSTNAMES="${PASEO_HOSTNAMES:-paseo.ddvnguyen.com}"

exec "$HOME/.bun/bin/bun" "$DIST" "$@"
EOF
    chmod +x "$ROOT/PROD/paseo-bun"
  fi
}

# ── Phase 3: wire-up units + runner env + restart ──────────────────────────
phase_wireup() {
  log "── phase 3: wire-up systemd units + runner env ──"
  run mkdir -p "$UNIT_DST"

  local u
  for u in paseo.service paseo-test.service paseo-prestart.sh; do
    [ -e "$UNIT_SRC/$u" ] || die "missing template: $UNIT_SRC/$u"
    backup_file "$UNIT_DST/$u"
    log "install unit: $UNIT_SRC/$u -> $UNIT_DST/$u"
    run cp -f "$UNIT_SRC/$u" "$UNIT_DST/$u"
    run chmod +x "$UNIT_DST/$u"
  done

  # GH runner .env: repoint LD_LIBRARY_PATH at the consolidated PROD tree.
  if [ -e "$RUNNER_ENV" ]; then
    backup_file "$RUNNER_ENV"
    if [ "$DRY_RUN" -eq 0 ]; then
      sed -i \
        -e 's#/home/ddv/paseo-prod-bun/node_modules#/home/ddv/paseo/PROD/node_modules#g' \
        -e 's#/home/ddv/paseo-PROD/node_modules#/home/ddv/paseo/PROD/node_modules#g' \
        "$RUNNER_ENV"
      log "updated $RUNNER_ENV"
    else
      printf '[dry-run] sed -i s#paseo-prod-bun#paseo/PROD# %s\n' "$RUNNER_ENV"
    fi
  else
    warn "runner env not found: $RUNNER_ENV"
  fi

  run systemctl --user daemon-reload

  if [ "$SKIP_RESTART" -eq 1 ]; then
    log "restart skipped (--skip-restart)"
    return 0
  fi

  log "restart paseo-test"
  run systemctl --user restart paseo-test.service
  log "restart paseo-app"
  run systemctl --user restart paseo-app.service
  log "restart paseo (PROD) — this drops active agent sessions"
  run systemctl --user restart paseo.service
}

# ── Phase 4: verify ────────────────────────────────────────────────────────
phase_verify() {
  log "── phase 4: verify ──"
  if [ "$DRY_RUN" -eq 1 ]; then
    log "dry-run: skipping live verification"
    return 0
  fi
  sleep 3
  local unit
  for unit in paseo paseo-test paseo-app; do
    printf '[consolidate] %s: %s\n' "$unit" "$(systemctl --user is-active "$unit.service" 2>/dev/null || true)"
  done
  printf '[consolidate] TEST  health: %s\n' "$(curl -sf http://127.0.0.1:6868/api/health 2>/dev/null || echo unreachable)"
  printf '[consolidate] PROD  health: %s\n' "$(curl -sf http://127.0.0.1:6767/api/health 2>/dev/null || echo unreachable)"
  printf '[consolidate] app   HTTP:   %s\n' "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6969/ 2>/dev/null || echo unreachable)"
  printf '[consolidate] pnpm store: %s\n' "$(pnpm store path 2>/dev/null || echo unknown)"
  du -sh "$ROOT" 2>/dev/null || true
}

# ── Main ───────────────────────────────────────────────────────────────────
preflight
[ "$SKIP_RECLAIM" -eq 0 ] && phase_reclaim
[ "$RECLAIM_ONLY" -eq 1 ] && { log "reclaim-only: done"; exit 0; }
phase_dev
phase_consolidate
phase_wireup
phase_verify
log "done. Backups: $BACKUP_DIR"
