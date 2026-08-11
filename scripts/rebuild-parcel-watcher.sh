#!/usr/bin/env bash
# rebuild-parcel-watcher.sh — Apply the EINTR fix to @parcel/watcher and rebuild
# its native binary. Called from deploy-production.sh after `npm ci` wipes
# node_modules.
#
# Why: @parcel/watcher 2.6.0's inotify backend treats a transient EINTR on
# poll() as fatal and kills the watcher. The daemon spawns git/gh children,
# whose SIGCHLD interrupts poll() in every watcher thread simultaneously, so at
# scale every watcher dies and the paseo workspace-git service re-subscribes in
# a storm (each re-subscribe is a synchronous directory walk) — wedging the
# daemon's event loop. Retrying poll() on EINTR eliminates the root cause.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WATCHER_DIR="$REPO_ROOT/node_modules/@parcel/watcher"
SOURCE_FILE="$WATCHER_DIR/src/linux/InotifyBackend.cc"
PREBUILT_BIN="$REPO_ROOT/node_modules/@parcel/watcher-linux-x64-glibc/watcher.node"

if [ ! -d "$WATCHER_DIR" ]; then
  echo "  @parcel/watcher not installed — skipping (upstream file-observer is used instead)"
  exit 0
fi

# Idempotent: if the fix is already applied, skip the source patch + rebuild.
# The prebuilt binary is still replaced below either way.
if grep -q "errno == EINTR" "$SOURCE_FILE"; then
  echo "  @parcel/watcher EINTR fix already applied — skipping patch"
else
  python3 - "$SOURCE_FILE" <<'PY'
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

old = """    int result = poll(pollfds, 2, 500);
    if (result < 0) {
      throw std::runtime_error(std::string("Unable to poll: ") + strerror(errno));
    }"""

new = """    int result = poll(pollfds, 2, 500);
    if (result < 0) {
      // EINTR (interrupted system call) is transient: a signal (e.g. SIGCHLD
      // from a child git/gh process) was delivered while we were polling.
      // It is not a backend failure — the inotify descriptor is still valid —
      // so retry instead of tearing down the whole subscription. Treating
      // EINTR as fatal made every watcher die under any child-process load,
      // forcing constant re-subscribes (synchronous directory walks) that
      // wedged the daemon's event loop.
      if (errno == EINTR) {
        continue;
      }
      throw std::runtime_error(std::string("Unable to poll: ") + strerror(errno));
    }"""

if old not in src:
    sys.exit("ERROR: InotifyBackend.cc poll loop changed upstream; EINTR fix cannot be applied")

with open(path, "w", encoding="utf-8") as f:
    f.write(src.replace(old, new))
PY

  echo "  @parcel/watcher EINTR fix applied — rebuilding native module..."
  cd "$WATCHER_DIR"
  export npm_config_build_from_source=true
  npx --yes node-gyp rebuild 2>&1 | tail -3
fi

# index.js resolves @parcel/watcher-<platform>-<arch> (the prebuilt package)
# BEFORE ./build/Release/watcher.node, so the rebuilt binary must replace the
# prebuilt one or the EINTR fix is silently ignored at runtime. This also
# covers the skip path (fix already built) where npm ci may have re-downloaded
# the pristine prebuilt binary.
if [ -f "$PREBUILT_BIN" ] && [ -f "$WATCHER_DIR/build/Release/watcher.node" ]; then
  cp -f "$WATCHER_DIR/build/Release/watcher.node" "$PREBUILT_BIN"
  echo "  Replaced prebuilt: $PREBUILT_BIN"
fi
echo "  Rebuilt: $WATCHER_DIR/build/Release/watcher.node"
