# Fork delta ledger — upstream/main integration

What the fork owned, what the merge kept, and what it threw away.

Integration baseline `386e4fd4e` (origin/Paseo-hub) merged with `97083dd73`
(upstream/main) as merge commit `921702068`. **119 conflicted paths, every one
resolved to the upstream side.** No fork conflict resolution was attempted in
this commit — it is a mechanical baseline, and this document is the receipt for
what that cost.

Read this before touching anything the fork built. Read
[at-risk-commits.md](at-risk-commits.md) for the per-commit verdicts.

## The one-paragraph version

The fork had moved this repo to **pnpm** and built three products on top of it:
the Freebuff provider, the trajectory ledger plugin, and a plugin dialog system.
Upstream moved in a different direction — it is **npm**-based, and it rewrote the
composer, the agent stream, the settings surface and the ACP provider. Resolving
to upstream therefore discarded most of the fork's app-layer work, and — because
non-conflicted fork files were left alone — left the tree **referencing protocol
surface that no longer exists**. The tree does not typecheck. See
[What is broken right now](#what-is-broken-right-now).

The owner has since ruled that **this fork stays on pnpm**, and the CI and
package-manager losses have been re-applied on this branch. `pnpm-lock.yaml` is
the authoritative lockfile; `package-lock.json` and `bun.lock` are deleted. See
[Re-applied since](#re-applied-since--ci-and-the-package-manager) and
[Lockfile authority](#lockfile-authority).

## Numbers

| | Count |
| --- | --- |
| Conflicted paths resolved to upstream | 119 |
| Fork-changed paths now byte-identical to upstream | 184 |
| — of those, behavioural (not `package.json` churn, not tests) | 123 |
| Fork-only commits with work lost | 147 |
| Commits that upstream had already taken | 5 |

## What is broken right now

`npm run build:server` fails with **19 TypeScript errors in 7 files**, all in
`packages/server`. This is not stale build output — the declarations were
rebuilt first. Four independent causes, all the same shape: a conflicted file
went to upstream, and a fork file that was *not* in conflict still depends on
what the fork had put there.

| Cause | Errors | Mechanism |
| --- | --- | --- |
| A | 14 | `protocol/src/messages.ts` went to upstream, so the fork's `agent.background_tasks.list.{request,response}` and `AgentManager.listBackgroundTasks` are gone. `session.ts`, `authorization/operation-permissions.ts` and `session/owned-subscriptions/replies.ts` still reference them. |
| B | 2 | Upstream deleted `quota-fetcher/manifest.ts` and split the `providers/` directory rename. The fork-only `quota-fetcher/providers/freebuff.ts` still imports `../provider.js` and `../usage.js`. |
| C | 1 | `acp-agent.ts` went to upstream, which narrowed `GenericACPAgentClientOptions` and dropped `providerParams` that `freebuff-acp-agent.ts` passes. |
| D | 2 | Upstream is npm, the fork is pnpm; `semver/functions/compare.js` has no declaration file in this tree. |

Cause A traces to fork commits `01ab14e01` and `01b888d06`, which introduced the
background-task RPC. Both are RE-APPLIED in the commit ledger. **These 19 errors
are not in this area's scope** — `packages/fleet-backend` belongs to the paseo#31
leader and the server/protocol re-application belongs to the server area. They are
recorded here because the ledger's job is to make them findable, not to fix them.

## The 184 dropped paths

### Dropped — fork product work, must be re-applied

These are the paths where the fork's behaviour is simply gone.

- **Freebuff** — `packages/server/src/services/quota-fetcher/providers/freebuff.ts`,
  the whole `freebuff-acp-agent.ts` surface, the ACP `requireApproval` fail-closed
  work (`06a692fed`, `edf623abb`), the seat/login hardening series, and the
  plugin-side settings and model-catalog RPCs.
- **Plugin dialog system** — `packages/app/src/plugins/buttons/view.tsx` (both the
  retained-panel gating `17453d683` and the active-screen gating `29f18bc12`),
  `components/adaptive-modal-sheet.tsx` (edge-to-edge mode `2adfa4ba3`, the
  `surfaceOwnsClose` contract `baea49996`, the single-toolbar-row fix
  `321ee2ca7`, the explicit-height ceiling `8a2ae9d31`), and the
  `SettingsIconButton` primitives `988a4e3bb`.
- **App shell and settings** — `appearance/apply.ts`, `hooks/use-settings/*`,
  `composer/*`, `agent-stream/*`, `styles/theme.ts`, `runtime/replica-cache/*`.
  The appearance-scale restoration (`87494c397`) and the sidebar-nav restoration
  (`c126cb553`) are both in this group.
- **Background tasks** — the protocol RPC and its composer toolbar UI. This is
  the one that is actively breaking the build (cause A).

### Re-applied since — CI and the package manager

Owner ruled the fork stays on pnpm. Two of the losses above are now repaired on
this branch; the rest of this section still stands.

**`ci.yml` pnpm install — RE-APPLIED** (`9af9baa9d`). All 11 job sites converted
back: `pnpm/action-setup@v4`, `cache: pnpm`,
`cache-dependency-path: pnpm-lock.yaml`, `pnpm install --frozen-lockfile`,
replacing `cache: "npm"` and `node scripts/npm-retry.mjs ci`. Upstream's
`Lint lockfile` step was **removed rather than ported** — it ran `lockfile-lint`
against `package-lock.json`, which this fork no longer keeps, so leaving it would
gate CI on an absent file. Three steps named "Install dependencies with retry"
were renamed, because the retry wrapper is gone. That wrapper was upstream's
answer to transient registry failures; under pnpm there is none, so a flaky
network is now a failed job rather than a retried one. The fork's own base
(`386e4fd4e`) had no retry either, so this restores the fork's state rather than
inventing one.

**`ci.yml` job scoping — RE-APPLIED** (`9af9baa9d`). All 6 occurrences of
`PASEO_CI_ALL_PLATFORMS` are back; the merged file had zero. Three jobs gated,
with conditions copied verbatim from `386e4fd4e`: `server-tests-macos`,
`desktop-tests-ubuntu`, `desktop-tests-windows`. The other 16 jobs stay ungated,
and there is no iOS job, so nothing iOS runs on PRs is gated. This was a
regression, not a supersession: the scoping was new on Paseo-hub as of #38, so
the merge deleted rather than overwrote it.

**Lockfile authority — DECIDED** (`5fccf7b16`). `pnpm-lock.yaml` is
authoritative. `package-lock.json` and `bun.lock` are deleted, leaving one
root lockfile. See [Lockfile authority](#lockfile-authority) below.

**Workspace linking — RE-APPLIED** (`00f656e8e`). `link-workspace-packages` and
`prefer-workspace-packages` were in `.npmrc`, which pnpm 11 does not read; both
now live in `pnpm-workspace.yaml`.

### Still dropped — fork infrastructure

- **`.github/workflows/deploy-website.yml`** — lost the `pnpm-lock.yaml` path entry
  (`c06f1195a`), so release and rollout target npm again. Deliberately untouched:
  on the do-not-touch list.
- **`.gitignore`** — lost `/.deploy-production.lock` (`4f2b98137`) while
  `scripts/deploy-production.sh` still uses that lock, so the lock file can be
  committed again. Also lost the `.mcp.json` ignore (`35741dda9`, `ec158eb9e`).
- **Package manager contract** — `workspace:*` specifiers (`6d1afce38`), the
  metro-resolver declaration pnpm's isolated hoisting needs (`6ef5c741e`), and
  the `tsx` declarations upstream does not carry at all (`6f12c733e`,
  `4098ff877`).
- **P0 SDK pin** — `6af2c8665` pinned `@opencode-ai/sdk` to `1.18.23` for the Zen
  free-tier version gate; upstream holds `1.14.46` and the merge reverted it.
  Note the asymmetry: that commit's **guard test survived** in
  `event-consumer.test.ts` while the pin it guards did not, so the tree now
  carries the assertion without the fix. The server area must confirm what 1.14.46
  does before assuming the gate still holds.

### Kept

Not everything was lost. These fork changes survived because their paths did not
conflict, or because the commit also touched files the merge left alone:

- `.github/ci-paths.yml` — still routes `fleet-backend`.
- `pnpm-workspace.yaml` — fork-only (upstream has no such file), so the merge had
  nothing to resolve against. It is also where `plugin-examples` is registered as
  a workspace (`7d9e8cf39`).
- The `event-consumer.test.ts` reader.cancel() regression test from `6af2c8665`.
- `docs/fork/*` — this directory.

### Partially kept

- `bdad61141` — the `paseo:worker-heartbeat` reply survives in
  `supervisor.logging.test.ts`; the `branches: [main, Paseo-hub]` lines did not.
- `eeb0c6056` — expo is `^54.0.18` on both sides, so upstream independently
  carries that alignment.
- `packages/app/src/agent-stream/view.tsx`, `components/agent-list.tsx` — large
  upstream rewrites that absorbed part of the fork's shape; the surviving subset
  is not a clean subset of the original intent.

### Dropped on purpose

- **34 workspace version-stamping commits.** Regenerated by
  `scripts/sync-workspace-versions.mjs`; no runtime behaviour.
- **`c537bd2f5`** — restoring the `-hydra` identifier into root `package.json`
  conflicts with upstream owning that file's versioning; the fork stamps at build
  time instead.

## Lockfile authority

Resolved: **`pnpm-lock.yaml` is the only root lockfile** (`5fccf7b16`).

The merge left three side by side with nothing choosing between them. The fork's
own documentation had already settled it — `docs/fork-maintenance.md` says "the
only lockfile is `pnpm-lock.yaml`; there is no `package-lock.json`" — so the tree
was contradicting itself.

| File | Decision | Why |
| --- | --- | --- |
| `pnpm-lock.yaml` | authoritative | the package manager this fork actually runs |
| `package-lock.json` | deleted | upstream's; restored by the merge resolving a modify/delete conflict to upstream |
| `bun.lock` | deleted | fork-only, nothing consumes it |

**`bun.lock`** was added by fork commit `0a0566870` to align with Bun 1.4.
`package.json` declares no `packageManager` field and no script invokes bun.
Every reference to the file is a workaround to get rid of it, never a use:

- `.easignore` and `packages/app/.easignore` exclude it so EAS picks npm
- `.github/workflows/android-apk-release.yml` runs `rm -f bun.lock` before EAS

Those three guards were left in place. They are no-ops once the file is gone, and
they still cover the case where a tool regenerates one. `deploy/consolidate-
paseo-home.sh` and `rollback-paseo-home.sh` list it among items to remove on
deploy; those entries are now no-ops too.

`packages/app/e2e/browser/file-editing.spec.ts` writes a `package-lock.json`
into a seeded fixture workspace as test data for a large-file render test. That
is unrelated to the root lockfile and is unaffected.

### Known consequence of dropping npm

`.github/workflows/nix-update-hash.yml` diffs and commits `package-lock.json`,
so with the file gone that step will misbehave if `nix/npm-deps.hash` ever
changes. It is on the do-not-touch list, so it was left alone — **it needs an
owner decision.** `.github/workflows/deploy-website.yml` lists
`package-lock.json` as a path trigger, so it will simply stop triggering on it.
`lefthook.yml` excludes the file from hooks, now a no-op.

`docs/plugins.md` and `docs/release.md` still describe npm workflows in prose.
Neither was in scope; both will mislead a reader who follows them literally.

### The `.npmrc` trap

pnpm 11 reads settings from `pnpm-workspace.yaml`, not `.npmrc`. This is not
theory — measured on this tree: with `.npmrc` fully populated,
`pnpm config get link-workspace-packages` returned `undefined`, and
`pnpm config list` showed none of its keys, `public-hoist-pattern` included.

`link-workspace-packages` and `prefer-workspace-packages` moved to
`pnpm-workspace.yaml` (`00f656e8e`); without them a frozen-lockfile install
resolved workspace deps from the registry and failed on
`@getpaseo/expo-two-way-audio`.

`public-hoist-pattern` was **not** migrated. It was already inert, so switching
it on would change module resolution in a way nothing here has validated. That is
a separate decision, and `.npmrc` now says so at the top of the file.

## Manifest and lockfile reconciliation

A sibling agent reported the lockfile as inconsistent with the merged manifests:
27 specifier mismatches, root `tsx` blocking `pnpm install --frozen-lockfile`, and
a half-reverted `6d1afce38`. Most of that did not reproduce. What follows is what
was measured, because the difference matters for anyone who reads the report
instead of the tree.

**Root `tsx` — RE-APPLIED (`b0d0259ca`), and it was real.** Fork commit
`4098ff877` added `"tsx": "^4.21.0"` to the root `devDependencies`, because the
source daemon and the supervisor fixtures spawn as `node --import tsx` from the
repository root and pnpm's isolated `node_modules` does not hoist a workspace
package's dependency to the root. The merge resolved `package.json` to upstream
and the declaration went with it. Measured at the root before the fix:

```
node --import tsx -e "0"
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from .../a2-area-ledger/
```

After the fix it resolves. Restored at `^4.21.0`, the version the fork had and
the version the lockfile resolves.

Same shape as the `@opencode-ai/sdk` pin: the fork's change survived in one place
and was lost in another. Two instances of that pattern is a pattern, not
coincidence — see [What is broken right now](#what-is-broken-right-now) cause A
for the third.

**`6d1afce38` — SUPERSEDED, not half-reverted.** The commit did convert
`@getpaseo/*` from pinned versions (`0.7.2`) to `workspace:*` across
`packages/{cli,client,plugin,server}/package.json`, the lockfile,
`pnpm-workspace.yaml` and `scripts/sync-workspace-versions.mjs`. But it did not
survive half-reverted. Both halves went to upstream together:

- no manifest under `packages/` uses `workspace:*` today, and
- the lockfile does not either — `grep -c 'workspace:'` over the whole importers
  block returns **2**, both in `plugin-examples`, and both consistent.

So the manifests and the lockfile agree. The fork's `workspace:*` convention was
lost, but nothing is inconsistent and nothing is blocked. Its intent — making
frozen-lockfile installs resolve internal deps locally — is now served by a
different mechanism: `linkWorkspacePackages: true` in `pnpm-workspace.yaml`.
Restoring `workspace:*` would be a convention change, not a repair, and it would
rewrite the lockfile again. Left alone deliberately; see
[Open decisions](#open-decisions).

**Third-party specifiers — no change needed.** Four manifest/lockfile pairs
differ, all of them pnpm override semantics rather than defects. When an
`overrides:` entry rewrites a dependency, the lockfile records the
override-applied specifier, so it legitimately differs from the manifest's
requested range:

| Package | manifest | lockfile | why |
| --- | --- | --- | --- |
| `packages/website` `react` | `^19.1.4` | `19.1.0` | override pins `19.1.0` |
| `packages/website` `react-dom` | `^19.1.4` | `19.1.0` | same |
| `packages/app` `react-native-reanimated` | `~4.3.1` | `4.3.1` | override pins `4.3.1` |
| `packages/app` `react-native-worklets` | `~0.8.3` | `0.8.3` | override pins `0.8.3` |

The `react` pair is upstream's own arrangement, not a fork delta: `packages/
website` asks `^19.1.4` on the fork base, on upstream and at HEAD alike, while
upstream's **root** `package.json` pins `react` at exactly `19.1.0`. Our
override reproduces that root pin in pnpm's idiom. Nothing to reconcile.

**`lucide-react-native` — SUPERSEDED, and the report had it backwards.** Upstream
moved it from `0.x` to `1.x` in `d3c76be9c` ("Unify Explorer tabs and refine
launch controls", #5942). The fork base had `^0.546.0`; HEAD has `^1.50.0`,
which is what upstream carries and what the lockfile records. Taking upstream was
correct. The `^0.546.0` figure is what this fork *used* to declare, not what the
lockfile says.

**Two categories that are not mismatches at all**, recorded so the next person
does not re-investigate them:

- Eight `@getpaseo/*` entries compare as `*` against `'*'`. Identical values,
  differing only in YAML quoting. An artifact of a naive diff, not a defect.
- Three `packages/expo-two-way-audio` entries (`expo`, `react`,
  `react-native`) appear in the lockfile importer but not the manifest. Those are
  pnpm auto-installed peers — the lockfile sets `autoInstallPeers: true` — and
  they are how pnpm represents them.

### Open decisions

Not decided here, because neither is a repair:

- **Restore `workspace:*` for `@getpaseo/*`?** It is stricter than `*` and would
  make the fork's original intent explicit rather than delegated to
  `linkWorkspacePackages`. It also rewrites the lockfile. A convention choice for
  the owner.
- **`nix-update-hash.yml`** still diffs and commits `package-lock.json`, which no
  longer exists. Do-not-touch list, so flagged rather than fixed.

## Re-derive this

The helper that produced this baseline is not checked in — it lives outside the
repo, at `/mnt/WorkDisk/workspace/worktree/scratch/upstream-first-merge.sh`. Copy
it into the worktree root and pass the upstream ref explicitly:

```bash
cp /mnt/WorkDisk/workspace/worktree/scratch/upstream-first-merge.sh .
./upstream-first-merge.sh <branch> 97083dd73
```

Pin the ref. `upstream/main` moved `5c2c85ebc` → `97083dd73` → `5aee41952` while
this work was in flight, and the script's own `git fetch upstream main` means an
unpinned run silently gives each area a different baseline.

Two things about that script, both learned the hard way here:

- It resolves conflicts to upstream, then runs `pnpm install`. That install fails
  on `ERR_PNPM_IGNORED_BUILDS` until `msgpackr-extract` has a real boolean in
  `pnpm-workspace.yaml`, because pnpm 11 writes a literal
  `set this to true or false` placeholder. The file is fork-only, so the merge
  cannot resolve it.
- Its final `git commit` is subject to the lefthook pre-commit typecheck, which
  cannot pass on a resolve-to-upstream baseline. Use `--no-verify` and record why
  in the message, as all three commits on this branch do.

## Reproduce the two sets

```bash
MB=d8dd189b94548bfac12bc20ee1e9caf722d5d54c   # merge base of fork and upstream

# 184 dropped fork-delta paths
git diff --name-only $MB 386e4fd4e | while read f; do
  a=$(git rev-parse "386e4fd4e:$f" 2>/dev/null || echo ABSENT)
  b=$(git rev-parse "97083dd73:$f" 2>/dev/null || echo ABSENT)
  c=$(git rev-parse "HEAD:$f"        2>/dev/null || echo ABSENT)
  [ "$a" != "$b" ] && [ "$c" = "$b" ] && echo "$f"
done

# 147 at-risk commits: no upstream patch-equivalent, touching a dropped path
git log --cherry-pick --right-only --no-merges --format=%H 97083dd73...HEAD
```

Treat absence as a value. A plain `git rev-parse` that fails on a path the fork
*deleted* silently undercounts — that is exactly how `package-lock.json` gets
missed, and it is the single most consequential entry in this ledger.