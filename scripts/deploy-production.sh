#!/usr/bin/env bash
# deploy-production.sh — Build and deploy paseo to production systemd service.
# Usage: ./scripts/deploy-production.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_UI_SRC="$REPO_ROOT/packages/app/dist"
WEB_UI_DEST="$REPO_ROOT/packages/server/dist/server/web-ui"

echo "=== Paseo Production Deploy ==="
echo "Repo: $REPO_ROOT"

# 0. Stamp version with short commit hash
echo ""
echo "[0/6] Stamping version with commit hash..."
cd "$REPO_ROOT"
SHORT_HASH=$(git rev-parse --short HEAD)
CURRENT_VERSION=$(node -p "require('./package.json').version")
STAMPED_VERSION="${CURRENT_VERSION}-${SHORT_HASH}"
echo "  Version: $CURRENT_VERSION -> $STAMPED_VERSION"

# Update root package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$STAMPED_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "  Updated package.json"

# Sync workspace versions
node scripts/sync-workspace-versions.mjs

# 1. Install deps
echo ""
echo "[1/6] Installing dependencies..."
npm install --prefer-offline

# 2. Build server and web app only (skip desktop/mobile)
echo ""
echo "[2/6] Building server and web app..."
npm run build --workspace=@getpaseo/highlight
npm run build --workspace=@getpaseo/relay
npm run build --workspace=@getpaseo/protocol
npm run build --workspace=@getpaseo/client
npm run build --workspace=@getpaseo/server
npm run build --workspace=@getpaseo/cli

# 3. Build the web app (expo export)
echo ""
echo "[3/6] Building web app..."
cd "$REPO_ROOT/packages/app"
npm run build:web
cd "$REPO_ROOT"

# 4. Copy web UI dist to server location
echo ""
echo "[4/6] Copying web UI dist to server..."
mkdir -p "$WEB_UI_DEST"
rm -rf "$WEB_UI_DEST"
cp -r "$WEB_UI_SRC" "$WEB_UI_DEST"
echo "  Copied: $WEB_UI_SRC -> $WEB_UI_DEST"
ls "$WEB_UI_DEST" | head -5

# 5. Restart service (stop → wait → clear PID → start)
echo ""
echo "[5/6] Restarting paseo systemd service..."
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

# Stop existing daemon and wait for it to release PID lock
echo "  Stopping paseo..."
systemctl --user stop paseo 2>/dev/null || true
sleep 2

# Wait for old process to fully exit (check up to 10 seconds)
for i in $(seq 1 10); do
  if ! pgrep -f "paseo daemon" > /dev/null 2>&1; then
    echo "  Old process exited"
    break
  fi
  echo "  Waiting for old process to exit... ($i/10)"
  sleep 1
done

# Clear stale PID file
rm -f "$HOME/.paseo/paseo.pid"
echo "  Cleared PID file"

# Start fresh
echo "  Starting paseo..."
systemctl --user start paseo

# 6. Verify health
echo ""
echo "[6/6] Verifying health..."
sleep 3
HEALTH=$(curl -sf http://127.0.0.1:6767/api/health 2>/dev/null || echo '{"status":"error"}')
HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:6767/ 2>/dev/null || echo "000")

echo ""
echo "=== Deploy Complete ==="
echo "Version: $STAMPED_VERSION"
echo "Health: $HEALTH"
echo "Web UI HTTP: $HTTP_CODE"

if [ "$HTTP_CODE" = "200" ]; then
  echo "Status: OK"
else
  echo "Status: WARNING — Web UI returned HTTP $HTTP_CODE"
fi
