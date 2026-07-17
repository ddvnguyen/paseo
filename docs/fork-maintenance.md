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

| Component | File | Function |
|-----------|------|----------|
| CLI | `packages/cli/src/version.ts` | `resolveCliVersion()` |
| Web App | `packages/app/src/utils/app-version.ts` | `resolveAppVersion()` |
| Daemon | `packages/server/src/server/daemon-version.ts` | `resolveDaemonVersion()` |

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
```json
{
  "name": "@getpaseo/cli",
<<<<<<< HEAD
  "version": "0.1.109",
=======
  "version": "0.1.107-hydra",
>>>>>>> b66dadb99 (chore: rebase on v0.1.107, keep hydra patches)
```

**After (resolved):**
```json
{
  "name": "@getpaseo/cli",
  "version": "0.1.109-hydra",
```

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

| Part | Example | Description |
|------|---------|-------------|
| Base version | `0.1.109` | Upstream semver |
| Fork suffix | `-hydra` | Fork identifier |
| Hash suffix | `-h-ae5fc2d23` | Git commit short hash |

### Full Format

```
{major}.{minor}.{patch}-hydra-h-{commit-short-hash}
```

**Examples:**
- `0.1.109-hydra-h-ae5fc2d23`
- `0.2.0-hydra-h-b66dadb99`

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
