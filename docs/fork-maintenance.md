# Fork Maintenance Guide

This document covers maintaining the `hydra-paseo` fork, including rebasing on upstream and managing the version suffix.

## Version Suffix Convention

All workspace packages in this fork include a git commit hash suffix in their version string:

```
{upstream-version}-hydra-{commit-short-hash}-{yyMMDDhhmm}
```

**Example:** `0.7.0-beta.2-hydra-6d2f11cb9-2608302234`

### How It Works

1. Root `package.json` has version: `0.7.0-beta.2-hydra`
2. `scripts/sync-workspace-versions.mjs` appends `-{commit-short-hash}-{yyMMDDhhmm}`
3. All workspace packages get the full version with hash and timestamp suffix
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

| Part         | Example        | Description              |
| ------------ | -------------- | ------------------------ |
| Base version | `0.7.0-beta.2` | Upstream semver          |
| Fork suffix  | `-hydra`       | Fork identifier          |
| Hash suffix  | `-6d2f11cb9`   | Git commit short hash    |
| Timestamp    | `-2608302234`  | Build time, `yyMMDDhhmm` |

### Full Format

```
{major}.{minor}.{patch}(-beta.N)-hydra-{commit-short-hash}-{yyMMDDhhmm}
```

**Examples:**

- `0.7.0-beta.2-hydra-6d2f11cb9-2608302234`
- `0.7.0-hydra-b66dadb99-2609011530`

## Split Architecture: Daemon + Static Web UI

Both TEST and PROD run the daemon and web UI as two independent processes. The
web UI is a static file bundle served by Caddy; the daemon handles API, WebSocket,
and agent lifecycle. They don't proxy each other — the web UI client connects to
the daemon directly via the "Add host" flow.

```
Browser → Caddy (:6868 TEST / :6767 PROD) → static files (web-ui/)
Browser → Daemon (:6969 TEST / :6768 PROD) → API + WebSocket (via "Add host")
```

This means UI changes don't require a daemon restart, and daemon changes don't
require a UI rebuild.

### Why no reverse proxy

The web app already has a full host-connection registry (`HostConnection` /
`HostProfile` in `packages/app/src/runtime/host-runtime.ts`) that lets the
client pair with any daemon URL. This is the same mechanism mobile and desktop
apps use. The daemon already supports configurable CORS origins
(`daemon.cors.allowedOrigins` in persisted config). A same-origin proxy only
added auto-fill of the connection hint — we intentionally give that up for
independent deployability. First-time visitors do one "Add host" (daemon URL +
password), same UX as pairing the mobile app.

### Daemon flag: `--no-web-ui`

When Caddy serves the static files, the daemon must NOT also serve them. Start
the daemon with `--no-web-ui`:

```
paseo daemon --listen 127.0.0.1:6969 --no-web-ui     # TEST
paseo daemon --listen 127.0.0.1:6768 --no-web-ui     # PROD
```

### CORS configuration

The daemon's `config.json` must allow the static file server's origin. Add the
Caddy origin to `daemon.cors.allowedOrigins`:

```json
{
  "daemon": {
    "cors": {
      "allowedOrigins": ["https://app.paseo.sh", "http://localhost:6868", "http://localhost:6767"]
    }
  }
}
```

For TEST: edit `~/.paseo-test/config.json`.
For PROD: edit `~/paseo-prod-bun/config.json` (or wherever `PASEO_HOME` points).

The daemon also allows same-origin connections automatically (localhost variants
matching the listen port are included in `fixedAllowedOrigins`).

### Port layout

| Instance | Caddy (static files) | Daemon (API + WS) | Caddyfile                     |
| -------- | -------------------- | ----------------- | ----------------------------- |
| TEST     | :6868                | 127.0.0.1:6969    | `deploy/caddy/Caddyfile.test` |
| PROD     | :6767                | 127.0.0.1:6768    | `deploy/caddy/Caddyfile.prod` |

### Files

| File                                    | Purpose                                  |
| --------------------------------------- | ---------------------------------------- |
| `scripts/build-web-ui.mjs`              | Standalone web UI build → `dist/web-ui/` |
| `deploy/caddy/Caddyfile.test`           | TEST static file server config           |
| `deploy/caddy/Caddyfile.prod`           | PROD static file server config           |
| `deploy/systemd/paseo-app-test.service` | TEST Caddy systemd unit                  |
| `deploy/systemd/paseo-app.service`      | PROD Caddy systemd unit                  |

## Deployment

After rebasing and syncing versions, deploy the updated paseo.

### Prerequisites

- Node.js available in PATH
- Caddy installed (`/usr/bin/caddy`)
- Access to the paseo repository directory

### Deployment Steps

There are three deploy scenarios. Pick the one that matches what changed.

#### Scenario A: UI-only change (no daemon restart needed)

1. Build the standalone web UI bundle:

```bash
node scripts/build-web-ui.mjs
```

2. Copy to the deploy target:

```bash
# PROD
rsync -a --delete dist/web-ui/ ~/paseo-prod/web-ui/

# TEST
rsync -a --delete dist/web-ui/ ~/.paseo-test/web-ui/
```

3. Apply TEST branding (if TEST — skip for PROD): see "TEST branding
   preservation" below.

4. Reload Caddy (zero-downtime, no daemon restart):

```bash
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user reload paseo-app.service       # PROD
systemctl --user reload paseo-app-test.service  # TEST
```

#### Scenario B: Daemon-only change (no UI rebuild needed)

1. Build the daemon:

```bash
npm run build --workspace=@getpaseo/server
```

2. Deploy server dist:

```bash
# PROD
rsync -a --delete packages/server/dist/ ~/paseo-prod/node_modules/@getpaseo/server/dist/

# TEST
rsync -a --delete packages/server/dist/ ~/.paseo-test/node_modules/@getpaseo/server/dist/
```

3. Copy stamped package.json:

```bash
cp packages/server/package.json ~/.paseo-test/node_modules/@getpaseo/server/package.json
```

4. Restart daemon (drops active sessions):

```bash
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user restart paseo-test.service   # TEST
systemctl --user restart paseo.service        # PROD
```

Caddy does NOT need to restart — it serves static files independently.

#### Scenario C: Both daemon + UI changed

Do B then A (daemon first, then UI). The daemon restart is the disruptive part;
the UI reload is zero-downtime.

### TEST Branding Preservation

TEST branding lives durably at `~/.paseo-test-branding/` (survives full
rebuilds). After every web UI deploy to TEST, overlay these files onto the
fresh build:

1. **PWA icons** — copy from `~/.paseo-test-branding/`:
   - `favicon.ico`
   - `apple-touch-icon.png`
   - `pwa-icon-192.png`
   - `pwa-icon-512.png`

   Over the corresponding files in `~/.paseo-test/web-ui/`.

2. **Status favicons** — copy from `~/.paseo-test-branding/status-icons/`:
   - `none.png` → `~/.paseo-test/web-ui/assets/assets/images/favicon-dark.png`
   - `running.png` → `~/.paseo-test/web-ui/assets/assets/images/favicon-dark-running.png`
   - `attention.png` → `~/.paseo-test/web-ui/assets/assets/images/favicon-dark-attention.png`
   - Same for `light` variants.

   These override the tab favicon that `useFaviconStatus()` sets on every
   mount (the static `favicon.ico`/`pwa-icon-*` only affect the PWA install
   icon, not the browser tab).

3. **manifest.json** — patch `name` and `short_name` to "Paseo TEST". Delete
   `manifest.json.br` and `manifest.json.gz` (stale pre-compressed copies).
   **Do not override `theme_color`** — leave it at the app's real background
   (`#181B1A`). TEST stays visually distinct via the tinted icons alone.

### Systemd Service Configuration

#### Daemon units (existing, must add `--no-web-ui`)

| Unit                 | Location                                    | Port |
| -------------------- | ------------------------------------------- | ---- |
| `paseo-test.service` | `~/.config/systemd/user/paseo-test.service` | 6969 |
| `paseo.service`      | `~/.config/systemd/user/paseo.service`      | 6768 |

Both must run with `--no-web-ui` to avoid serving static files that Caddy handles.

#### Static file server units (new)

| Unit                     | Location                                        | Port |
| ------------------------ | ----------------------------------------------- | ---- |
| `paseo-app-test.service` | `~/.config/systemd/user/paseo-app-test.service` | 6868 |
| `paseo-app.service`      | `~/.config/systemd/user/paseo-app.service`      | 6767 |

Templates: `deploy/systemd/paseo-app-test.service`, `deploy/systemd/paseo-app.service`.

### Verification

After deployment, verify:

1. **Static web UI:** `curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:6868/`
   - Should return: `200`

2. **Daemon health (direct):** `curl -sf http://127.0.0.1:6969/api/health`
   - Should return: `{"status":"ok","timestamp":"..."}`

3. **Daemon version:** `journalctl --user -u paseo-test.service | grep -oE 'daemonVersion":"[^"]*"' | tail -1`
   - Must show the NEW hash after a daemon deploy.

### Troubleshooting Deployment

**Caddy won't start:**

- Check Caddy is installed: `which caddy`
- Check logs: `journalctl --user -u paseo-app-test.service --since "5 minutes ago"`
- Check port availability: `ss -tlnp | grep 6868`
- Validate config: `caddy validate --config ~/.paseo-test/Caddyfile --adapter caddyfile`

**Web UI returns 404:**

- Verify `~/.paseo-test/web-ui/index.html` exists
- Rebuild: `node scripts/build-web-ui.mjs`
- Copy to deploy target and reload Caddy

**WebSocket connection fails from web UI:**

- Verify daemon is running: `systemctl --user status paseo-test.service`
- Check daemon health directly: `curl -sf http://127.0.0.1:6969/api/health`
- Verify CORS: the daemon's `config.json` must include the web UI origin in `cors.allowedOrigins`
- Check browser console for CORS errors

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
daemon deploy must re-stamp versions from current HEAD so the suffix changes.

**For the current (reverse-proxy) architecture, see the three scenarios in
"Deployment" above.** The steps below are the legacy monolithic runbook,
retained for reference during the transition period.

### Legacy monolithic runbook (pre-reverse-proxy)

1. `node scripts/sync-workspace-versions.mjs` → workspaces become `{upstream-version}-hydra-<shorthash>-<yyMMDDhhmm>`
2. If app code changed: `CI=1 npm run build:daemon-web-ui` (purge /tmp/metro-cache first)
3. Deploy to `~/.paseo-test/node_modules/@getpaseo/`, **in this order** (web-ui
   branding must be the LAST thing touched under `dist/server/web-ui/`, or a
   later blanket dist rsync will silently overwrite it — see below):
   - if server code changed: replace server dist first —
     `rsync -a --delete packages/server/dist/ ~/.paseo-test/node_modules/@getpaseo/server/dist/`
     (this also wipes `dist/server/web-ui`, which is expected; branding is
     restored in the next step)
   - overlay fresh `packages/server/dist/server/web-ui`
   - PRESERVE TEST branding (see "TEST Branding Preservation" above)
   - copy stamped `packages/server/package.json`
4. `systemctl --user restart paseo-test.service`
5. Verify: `journalctl --user -u paseo-test.service | grep -oE 'daemonVersion":"[^"]*"' | tail -1`
   must show the NEW hash. Health: `curl :6868/api/health`.
