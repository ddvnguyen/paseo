#!/usr/bin/env bash
# deploy-production.sh — Build and deploy paseo to production systemd service.
# Usage: ./scripts/deploy-production.sh
#
# What it does:
# 1. Pull latest from origin/hydra-paseo
# 2. npm install
# 3. Build server + web app (skips desktop/mobile packaging)
# 4. Copy web UI dist to server expected location
# 5. Restart systemd service
# 6. Verify health
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_UI_SRC="$REPO_ROOT/packages/app/dist"
WEB_UI_DEST="$REPO_ROOT/packages/server/dist/server/web-ui"

echo "=== Paseo Production Deploy ==="
echo "Repo: $REPO_ROOT"

# 1. Pull latest
echo ""
echo "[1/6] Pulling latest from origin/hydra-paseo..."
cd "$REPO_ROOT"
git pull origin hydra-paseo

# 2. Install deps
echo ""
echo "[2/6] Installing dependencies..."
npm install --prefer-offline

# 3. Build server and web app only (skip desktop/mobile)
echo ""
echo "[3/6] Building server and web app..."
npm run build --workspace=@getpaseo/highlight
npm run build --workspace=@getpaseo/relay
npm run build --workspace=@getpaseo/protocol
npm run build --workspace=@getpaseo/client
npm run build --workspace=@getpaseo/server
npm run build --workspace=@getpaseo/cli

# Build the web app (expo export)
echo ""
echo "[4/6] Building web app..."
cd "$REPO_ROOT/packages/app"
npm run build:web
cd "$REPO_ROOT"

# 4. Copy web UI dist to server location
echo ""
echo "[5/6] Copying web UI dist to server..."
mkdir -p "$WEB_UI_DEST"
rm -rf "$WEB_UI_DEST"
cp -r "$WEB_UI_SRC" "$WEB_UI_DEST"
echo "  Copied: $WEB_UI_SRC -> $WEB_UI_DEST"
ls "$WEB_UI_DEST" | head -5

# 5. Restart service
echo ""
echo "[6/6] Restarting paseo systemd service..."
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user restart paseo

# 6. Verify health
sleep 3
HEALTH=$(curl -sf http://127.0.0.1:6767/api/health 2>/dev/null || echo '{"status":"error"}')
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:6767/ 2>/dev/null || echo "000")

echo ""
echo "=== Deploy Complete ==="
echo "Health: $HEALTH"
echo "Web UI HTTP: $HTTP_CODE"

if [ "$HTTP_CODE" = "200" ]; then
  echo "Status: OK"
else
  echo "Status: WARNING — Web UI returned HTTP $HTTP_CODE"
fi
