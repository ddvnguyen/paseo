# Fork Maintenance Guide

This document covers maintaining the `hydra-paseo` fork, including rebasing on upstream and managing the version suffix.

## Version Suffix Convention

All workspace packages in this fork include a git commit hash suffix in their version string:

```
{upstream-version}-hydra-h-{commit-short-hash}
```

**Example:** `0.1.109-hydra-h-ae5fc2d23`

### How It Works

1. Root `package.json` has version: `0.1.109-hydra`
2. `scripts/sync-workspace-versions.mjs` appends `-h-{commit-short-hash}`
3. All workspace packages get the full version with hash suffix
4. Internal `@getpaseo/*` dependencies are updated to match

### Version Resolution

Each component reads its version from its own `package.json`:

| Component | File                                           | Function                 |
| --------- | ---------------------------------------------- | ------------------------ |
| CLI       | `packages/cli/src/version.ts`                  | `resolveCliVersion()`    |
| Web App   | `packages/app/src/utils/app-version.ts`        | `resolveAppVersion()`    |
| Daemon    | `packages/server/src/server/daemon-version.ts` | `resolveDaemonVersion()` |

## Rebase Workflow

When upstream releases a new version, follow these steps to rebase the fork.

### Prerequisites

- Git configured with access to both `origin` (fork) and `upstream` (getpaseo/paseo)
- Clean working directory (commit or stash changes first)

### Step-by-Step Rebase

```bash
# 1. Navigate to the paseo directory
cd external/paseo

# 2. Fetch upstream changes
git fetch upstream

# 3. Start interactive rebase on upstream/main
git rebase upstream/main

# 4. Resolve conflicts (if any)
# When conflicts occur in package.json files:
#   - Take upstream version as base
#   - Add -hydra suffix to the version
#   - Update internal dependencies to match

# 5. After resolving conflicts, continue rebase
git add <resolved-files>
git rebase --continue

# 6. Once rebase completes, sync versions with hash
node scripts/sync-workspace-versions.mjs

# 7. Commit the synced versions
git add packages/*/package.json
git commit -m "chore: sync workspace versions with git hash suffix"

# 8. Verify the versions
grep '"version"' package.json packages/cli/package.json packages/server/package.json
```

### Conflict Resolution Pattern

When resolving version conflicts in `package.json` files:

**Before (conflict):**

````json
{
  "name": "@getpaseo/cli",
  "version": "0.1.109-hydra",```

**After (resolved):**

```json
{
  "name": "@getpaseo/cli",
  "version": "0.1.109-hydra",
````

For internal dependencies, update them to match:

```json
"dependencies": {
  "@getpaseo/client": "0.1.109-hydra",
  "@getpaseo/protocol": "0.1.109-hydra",
  "@getpaseo/server": "0.1.109-hydra",
}
```

### Automated Sync

After rebasing, run the sync script to automatically:

1. Get the current git commit hash
2. Append `-h-{hash}` to all workspace versions
3. Update all internal `@getpaseo/*` dependencies

```bash
# Sync versions (appends -h-{hash})
node scripts/sync-workspace-versions.mjs

# Or use npm script
npm run version:sync-internal
```

## Common Scenarios

### Scenario 1: New upstream patch release

```bash
git fetch upstream
git rebase upstream/main
# Resolve conflicts (take upstream version + -hydra suffix)
git rebase --continue
node scripts/sync-workspace-versions.mjs
git add packages/*/package.json
git commit -m "chore: sync workspace versions with git hash suffix"
```

### Scenario 2: New upstream minor/major release

Same as patch release, but review upstream changelog for breaking changes:

```bash
git fetch upstream
git log upstream/main..upstream/main --oneline  # Review changes
git rebase upstream/main
# Resolve conflicts and review code changes
git rebase --continue
node scripts/sync-workspace-versions.mjs
git add packages/*/package.json
git commit -m "chore: sync workspace versions with git hash suffix"
```

### Scenario 3: Adding hydra-specific patches

```bash
# Make your changes
git add <files>
git commit -m "feat: add hydra-specific feature"

# Sync versions
node scripts/sync-workspace-versions.mjs
git add packages/*/package.json
git commit -m "chore: sync workspace versions with git hash suffix"
```

## Version String Format

### Components

| Part         | Example        | Description           |
| ------------ | -------------- | --------------------- |
| Base version | `0.1.109`      | Upstream semver       |
| Fork suffix  | `-hydra`       | Fork identifier       |
| Hash suffix  | `-h-ae5fc2d23` | Git commit short hash |

### Full Format

```
{major}.{minor}.{patch}-hydra-h-{commit-short-hash}
```

**Examples:**

- `0.1.109-hydra-h-ae5fc2d23`
- `0.2.0-hydra-h-b66dadb99`

## Deployment

After rebasing and syncing versions, deploy the updated paseo to the systemd service.

### Prerequisites

- Paseo systemd service installed and enabled
- Access to the paseo repository directory
- npm and node available in PATH

### Deployment Steps

#### Option 1: Automated Deployment (Recommended)

Use the deployment script for a complete deployment:

```bash
# Run the deployment script
./scripts/deploy-production.sh
```

This script will:

1. Pull latest from origin/hydra-paseo
2. Install dependencies
3. Build server and web app
4. Copy web UI dist to server location
5. Restart systemd service
6. Verify health

#### Option 2: Manual Deployment

If you need more control, follow these steps:

```bash
# 1. Navigate to paseo directory
cd external/paseo

# 2. Install dependencies
npm install --prefer-offline

# 3. Build server and CLI
npm run build --workspace=@getpaseo/highlight
npm run build --workspace=@getpaseo/relay
npm run build --workspace=@getpaseo/protocol
npm run build --workspace=@getpaseo/client
npm run build --workspace=@getpaseo/server
npm run build --workspace=@getpaseo/cli

# 4. Install paseo CLI globally
npm install -g ./packages/cli

# 5. Restart systemd service
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user restart paseo

# 6. Verify deployment
sleep 3
curl -sf http://127.0.0.1:6767/api/health
paseo --version
```

### Systemd Service Configuration

The paseo service is configured as a user systemd service:

**Location:** `~/.config/systemd/user/paseo.service`

**Key Configuration:**

- Listens on `0.0.0.0:6767`
- Web UI enabled
- Relay enabled with TLS
- Auto-restart on failure

**Service Management Commands:**

```bash
# Check service status
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user status paseo

# Restart service
systemctl --user restart paseo

# Stop service
systemctl --user stop paseo

# View logs
journalctl --user -u paseo -f

# View recent logs
journalctl --user -u paseo --since "10 minutes ago"
```

### Verification

After deployment, verify:

1. **Health endpoint:** `curl -sf http://127.0.0.1:6767/api/health`
   - Should return: `{"status":"ok","timestamp":"..."}`

2. **Version check:** `paseo --version`
   - Should show: `0.2.0-beta.1-hydra-h-{commit-hash}`

3. **Service status:** `systemctl --user status paseo`
   - Should show: `Active: active (running)`

### Troubleshooting Deployment

**Service won't start:**

- Check logs: `journalctl --user -u paseo --since "5 minutes ago"`
- Verify node is in PATH: `which node`
- Check port availability: `ss -tlnp | grep 6767`

**Health endpoint fails:**

- Wait a few seconds for service to fully start
- Check if service is running: `systemctl --user status paseo`
- Check logs for errors

**Web UI returns 404:**

- Build web app: `cd packages/app && npm run build:web`
- Copy dist: `cp -r packages/app/dist packages/server/dist/server/web-ui/`
- Restart service

## Troubleshooting

### Version not updating

If the sync script doesn't update versions:

1. Check you're in the correct directory (`external/paseo`)
2. Verify git is available: `git rev-parse --short HEAD`
3. Check root `package.json` has a valid version

### Merge conflicts not resolving

If conflicts persist:

1. Abort the rebase: `git rebase --abort`
2. Fetch latest upstream: `git fetch upstream`
3. Try again: `git rebase upstream/main`

### Hash suffix not appearing

If versions don't have the hash suffix:

1. Run sync script manually: `node scripts/sync-workspace-versions.mjs`
2. Check git is available in the environment
3. Verify the script completed without errors

## References

- Upstream repository: https://github.com/getpaseo/paseo
- Fork repository: https://github.com/ddvnguyen/paseo
- Version sync script: `scripts/sync-workspace-versions.mjs`

## TEST deploy runbook (each deploy MUST advance the version suffix)

The user verifies a TEST deployment by reading `daemonVersion`. Therefore every
deploy must re-stamp versions from current HEAD so the suffix changes:

1. `node scripts/sync-workspace-versions.mjs` → workspaces become `0.6.1-hydra-<shorthash>`
2. If app code changed: `CI=1 npm run build:daemon-web-ui` (purge /tmp/metro-cache first)
3. Deploy to `~/.paseo-test/node_modules/@getpaseo/`:
   - overlay fresh `packages/server/dist/server/web-ui`
   - PRESERVE TEST branding: save & restore pwa-icon-512/192.png, favicon.ico,
     apple-touch-icon.png, assets/assets/images/\*.png; then patch manifest.json
     (name "Paseo TEST", theme_color #2563eb) and DELETE manifest.json.br siblings
   - copy stamped `packages/server/package.json` (version string source of truth)
   - if server code changed: replace server dist too
4. `systemctl --user restart paseo-test.service`
5. Verify: `journalctl --user -u paseo-test.service | grep -oE 'daemonVersion":"[^"]*"' | tail -1`
   must show the NEW hash. Health: `curl :6868/api/health`.
