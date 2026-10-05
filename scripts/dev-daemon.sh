#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

# Fail fast if the pinned bun is missing or the wrong version. The daemon runs on
# bun (packages/server `dev` execs it), so an unpinned runtime here would mean dev
# silently testing something the deploy never runs.
# shellcheck source=./bun-runtime.sh
source "$SCRIPT_DIR/bun-runtime.sh"
paseo_assert_bun
# Put the *asserted* binary first on PATH. Without this the package scripts below
# would resolve `bun` by name and could pick a different one, which would make
# the assertion above decorative.
export PATH="$(dirname "$BUN_BIN"):$PATH"

source "$SCRIPT_DIR/dev-home.sh"

export PASEO_LISTEN="${PASEO_LISTEN:-127.0.0.1:6768}"
configure_dev_paseo_home

if [ -z "${PASEO_LOCAL_MODELS_DIR}" ]; then
  export PASEO_LOCAL_MODELS_DIR="$HOME/.paseo/models/local-speech"
  mkdir -p "$PASEO_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  Paseo Dev Daemon"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${PASEO_HOME}"
echo "  Models:  ${PASEO_LOCAL_MODELS_DIR}"
echo "  Listen:  ${PASEO_LISTEN}"
echo "  Runtime: bun ${PASEO_REQUIRED_BUN_VERSION} (${BUN_BIN})"
echo "══════════════════════════════════════════════════════"

export PASEO_CORS_ORIGINS="${PASEO_CORS_ORIGINS:-*}"
export PASEO_NODE_INSPECT="${PASEO_NODE_INSPECT:---inspect=0}"

if [ "${PASEO_SKIP_DEV_SERVER_BUILD:-0}" = "1" ]; then
  exec npm run dev:server:watch
fi

exec sh -c 'npm run build:server-deps && npm run dev:server:watch'
