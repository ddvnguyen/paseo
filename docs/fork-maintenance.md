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

The daemon and web UI are two independent processes. The web UI is a single
static file bundle served by Caddy on port 6969; the daemons handle API,
WebSocket, and agent lifecycle on their existing ports (TEST :6868, PROD :6767).
They don't proxy each other — the web UI client connects to whichever daemon the
user configures at runtime via the "Add host" flow.

```
Browser → paseo-app (Caddy :6969)          → static files (web-ui/)
Browser → daemon (TEST :6868 / PROD :6767) → API + WebSocket (via "Add host")
```

This means UI changes don't require a daemon restart, and daemon changes don't
require a UI rebuild. There is only ONE paseo-app instance — it serves the same
static bundle for both environments; the client connects to whichever daemon the
user pairs with.

### Why no reverse proxy

The web app already has a full host-connection registry (`HostConnection` /
`HostProfile` in `packages/app/src/runtime/host-runtime.ts`) that lets the
client pair with any daemon URL. This is the same mechanism mobile and desktop
apps use. The daemon already supports configurable CORS origins
(`daemon.cors.allowedOrigins` in persisted config). First-time visitors do one
"Add host" (daemon URL + password), same UX as pairing the mobile app.

### Daemon flag: `--no-web-ui`

When Caddy serves the static files, the daemon must NOT also serve them. Start
each daemon with `--no-web-ui`:

```
paseo daemon --listen 127.0.0.1:6868 --no-web-ui   # TEST (keeps its current port)
paseo daemon --listen 127.0.0.1:6767 --no-web-ui   # PROD (keeps its current port)
```

### CORS configuration

Both daemons must allow the paseo-app origin. Add `http://localhost:6969` (or
the real domain once deployed) to `daemon.cors.allowedOrigins` in each daemon's
config.json:

```json
{
  "daemon": {
    "cors": {
      "allowedOrigins": ["https://app.paseo.sh", "http://localhost:6969"]
    }
  }
}
```

**TEST:** edit `~/.paseo-test/config.json`.
**PROD:** edit `~/paseo-prod-bun/config.json` (or wherever `PASEO_HOME` points).

TODO(ddv): replace `http://localhost:6969` with the real paseo-app origin once
the static file server is deployed to a persistent host (e.g.
`https://app.ddvnguyen.com`). The daemons also allow same-origin connections
automatically (localhost variants matching the listen port are in
`fixedAllowedOrigins`).

### Port layout

| Component         | Port  | Purpose                         |
| ----------------- | ----- | ------------------------------- |
| paseo-app (Caddy) | :6969 | Static web UI (single instance) |
| TEST daemon       | :6868 | API + WebSocket (unchanged)     |
| PROD daemon       | :6767 | API + WebSocket (unchanged)     |

### Files

| File                               | Purpose                                  |
| ---------------------------------- | ---------------------------------------- |
| `scripts/build-web-ui.mjs`         | Standalone web UI build → `dist/web-ui/` |
| `deploy/caddy/Caddyfile`           | Static file server config (port 6969)    |
| `deploy/systemd/paseo-app.service` | Caddy systemd unit for paseo-app         |

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
rsync -a --delete dist/web-ui/ ~/paseo-app/web-ui/
```

3. Apply TEST branding if needed (see "TEST branding preservation" below).

4. Reload Caddy (zero-downtime, no daemon restart):

```bash
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user reload paseo-app.service
```

#### Scenario B: Daemon-only change (no UI rebuild needed)

1. Build the daemon:

```bash
npm run build --workspace=@getpaseo/server
```

2. Deploy server dist:

```bash
# TEST
rsync -a --delete packages/server/dist/ ~/.paseo-test/node_modules/@getpaseo/server/dist/

# PROD
rsync -a --delete packages/server/dist/ ~/paseo-prod/node_modules/@getpaseo/server/dist/
```

3. Copy stamped package.json:

```bash
# TEST
cp packages/server/package.json ~/.paseo-test/node_modules/@getpaseo/server/package.json
# PROD
cp packages/server/package.json ~/paseo-prod/node_modules/@getpaseo/server/package.json
```

4. Restart the affected daemon (drops active sessions):

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

With the single paseo-app instance, the static web UI bundle is shared. TEST
branding (tinted icons, "Paseo TEST" manifest name) is applied to the web-ui
files at `~/paseo-app/web-ui/` before each deploy. Note: this means the shared
bundle temporarily shows TEST branding until the next PROD deploy overwrites it.
If this is unacceptable, deploy separate web-ui directories and switch the
Caddyfile `root` directive per-environment.

TEST branding lives durably at `~/.paseo-test-branding/` (survives full
rebuilds). After every web UI deploy, overlay these files onto `~/paseo-app/web-ui/`:

1. **PWA icons** — copy from `~/.paseo-test-branding/`:
   - `favicon.ico`
   - `apple-touch-icon.png`
   - `pwa-icon-192.png`
   - `pwa-icon-512.png`

   Over the corresponding files in `~/paseo-app/web-ui/`.

2. **Status favicons** — copy from `~/.paseo-test-branding/status-icons/`:
   - `none.png` → `~/paseo-app/web-ui/assets/assets/images/favicon-dark.png`
   - `running.png` → `~/paseo-app/web-ui/assets/assets/images/favicon-dark-running.png`
   - `attention.png` → `~/paseo-app/web-ui/assets/assets/images/favicon-dark-attention.png`
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
| `paseo-test.service` | `~/.config/systemd/user/paseo-test.service` | 6868 |
| `paseo.service`      | `~/.config/systemd/user/paseo.service`      | 6767 |

Both must run with `--no-web-ui` to avoid serving static files that Caddy handles.

#### Static file server unit (new, single instance)

| Unit                | Location                                   | Port |
| ------------------- | ------------------------------------------ | ---- |
| `paseo-app.service` | `~/.config/systemd/user/paseo-app.service` | 6969 |

Template: `deploy/systemd/paseo-app.service`.

### Verification

After deployment, verify:

1. **Static web UI:** `curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:6969/`
   - Should return: `200`

2. **Daemon health (direct):** `curl -sf http://127.0.0.1:6868/api/health`
   - Should return: `{"status":"ok","timestamp":"..."}` (TEST)
   - Or: `curl -sf http://127.0.0.1:6767/api/health` (PROD)

3. **Daemon version:** `journalctl --user -u paseo-test.service | grep -oE 'daemonVersion":"[^"]*"' | tail -1`
   - Must show the NEW hash after a daemon deploy.

### Troubleshooting Deployment

**Caddy won't start:**

- Check Caddy is installed: `which caddy`
- Check logs: `journalctl --user -u paseo-app.service --since "5 minutes ago"`
- Check port availability: `ss -tlnp | grep 6969`
- Validate config: `caddy validate --config ~/paseo-app/Caddyfile --adapter caddyfile`

**Web UI returns 404:**

- Verify `~/paseo-app/web-ui/index.html` exists
- Rebuild: `node scripts/build-web-ui.mjs`
- Copy to deploy target and reload Caddy

**WebSocket connection fails from web UI:**

- Verify daemon is running: `systemctl --user status paseo-test.service` (or `paseo.service`)
- Check daemon health directly: `curl -sf http://127.0.0.1:6868/api/health`
- Verify CORS: the daemon's `config.json` must include `http://localhost:6969` (or the real paseo-app origin) in `cors.allowedOrigins`
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

## Manual Pipeline (GitHub Actions)

`.github/workflows/paseo-manual-pipeline.yml` — workflow_dispatch only, no
automatic triggers. Runs on the self-hosted runner (`paseo-host`) at
`/mnt/WorkDisk/actions-runners/paseo`.

### Triggering

```bash
gh workflow run paseo-manual-pipeline.yml \
  -f run_build_hydra=true \
  -f run_deploy_web=true \
  -f run_deploy_test=true
```

Or use the GitHub Actions UI — tick whichever stages you need.

### Stages

| Stage            | Input               | What it does                                                                                     |
| ---------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| 1. Build hydra   | `run_build_hydra`   | Checkout, `npm ci`, build server + web UI, persist to `builds/hydra/<sha>/`                      |
| 2. Android APK   | `run_build_android` | Expo prebuild + `gradlew assembleRelease` (JDK 17, local SDK), output `builds/android/<sha>.apk` |
| 3. Deploy web UI | `run_deploy_web`    | Build web UI from SHA, rsync to `~/paseo-app/web-ui/`, reload Caddy on `:6969`                   |
| 4. Deploy TEST   | `run_deploy_test`   | Rsync server dist to `~/.paseo-test/`, restart `paseo-test.service` (`:6868`)                    |
| 5. Deploy PROD   | `run_deploy_prod`   | Rsync server dist to `~/paseo-prod-bun/`, restart `paseo.service` (`:6767`) ⚠️                   |

Stage 1 must run first (or a valid `*_build_ref` SHA must be supplied) for
stages 2–5. When both selected in one run, stages 2–5 wait for stage 1 via
`needs:`. Each stage is independently toggleable.

⚠️ Stage 5 restarts the PROD daemon, which drops all active agent sessions.
Only tick it when you have explicit permission.

### Persisted builds

```
/mnt/WorkDisk/actions-runners/paseo/builds/
├── hydra/<full-sha>/    # Complete repo tree with built artifacts
└── android/<sha>.apk   # Release APK
```

## References

- Upstream repository: https://github.com/getpaseo/paseo
- Fork repository: https://github.com/ddvnguyen/paseo
- Version sync script: `scripts/sync-workspace-versions.mjs`

## TEST deploy runbook (each deploy MUST advance the version suffix)

The user verifies a TEST deployment by reading `daemonVersion`. Therefore every
daemon deploy must re-stamp versions from current HEAD so the suffix changes.

**For the current split architecture, see the three scenarios in
"Deployment" above.** The steps below are the legacy monolithic runbook,
retained for reference during the transition period.

### Legacy monolithic runbook (pre-split)

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
