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

|                                                               | Count |
| ------------------------------------------------------------- | ----- |
| Conflicted paths resolved to upstream                         | 119   |
| Fork-changed paths now byte-identical to upstream             | 184   |
| — of those, behavioural (not `package.json` churn, not tests) | 123   |
| Fork-only commits with work lost                              | 147   |
| Commits that upstream had already taken                       | 5     |

## What is broken right now

`npm run build:server` fails with **19 TypeScript errors in 7 files**, all in
`packages/server`. This is not stale build output — the declarations were
rebuilt first. Four independent causes, all the same shape: a conflicted file
went to upstream, and a fork file that was _not_ in conflict still depends on
what the fork had put there.

| Cause | Errors | Mechanism                                                                                                                                                                                                                                                                              |
| ----- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A     | 14     | `protocol/src/messages.ts` went to upstream, so the fork's `agent.background_tasks.list.{request,response}` and `AgentManager.listBackgroundTasks` are gone. `session.ts`, `authorization/operation-permissions.ts` and `session/owned-subscriptions/replies.ts` still reference them. |
| B     | 2      | Upstream deleted `quota-fetcher/manifest.ts` and split the `providers/` directory rename. The fork-only `quota-fetcher/providers/freebuff.ts` still imports `../provider.js` and `../usage.js`.                                                                                        |
| C     | 1      | `acp-agent.ts` went to upstream, which narrowed `GenericACPAgentClientOptions` and dropped `providerParams` that `freebuff-acp-agent.ts` passes.                                                                                                                                       |
| D     | 2      | Upstream is npm, the fork is pnpm; `semver/functions/compare.js` has no declaration file in this tree.                                                                                                                                                                                 |

Cause A traces to fork commits `01ab14e01` and `01b888d06`, which introduced the
background-task RPC. Both are RE-APPLIED in the commit ledger. **These 19 errors
are not in this area's scope** — `packages/fleet-backend` belongs to the paseo#31
leader and the server/protocol re-application belongs to the server area. They are
recorded here because the ledger's job is to make them findable, not to fix them.

### Status after the area merges

Three of the four causes above are closed on this branch. `a2-area-server2`
supplied cause B (freebuff's quota-fetcher adapter is gone),
cause C (`providerOptions` replaced `providerParams`) and cause D
(`@types/semver` is declared again in `packages/protocol`).

**Cause A is still open, and `a2-area-protocol` was deliberately not merged.**
Its worktree still carries uncommitted changes — `packages/plugin/src/client/ui.ts`
modified, `upstream-first-merge.sh` untracked — so it was skipped rather than
half-merged. The residue is exactly what it owns:

- `AgentManager.backgroundTasks` does not exist on `ActiveManagedAgent`
  (`agent-manager.ts`), which is the background-task RPC from cause A.
- `"agent.closed"` is not a member of `PluginLifecycleEvents`.

So `npm run typecheck` cannot pass repo-wide until `a2-area-protocol` lands. That
is why every commit on this branch was made with `--no-verify` and says so;
lefthook's pre-commit typecheck runs `npm run typecheck` across all workspaces
with no glob filter. `oxfmt --check` and `oxlint` were run manually instead, and
both are clean apart from one inherited item:

- `packages/app/src/composer/agent-controls/index.tsx` — `eslint(complexity)`:
  `AgentControls` is at 21, limit 20. Verified attributable to `a2-area-app`: with
  `97083dd73`'s version of that file at that path, oxlint reports 0 errors; with
  `a2-area-app`'s it reports this. The added `useExcludedModelIdsByProvider` call
  and its ternary are what cross the threshold. Left for an app owner rather than
  papered over with a lint ceiling bump.

One merge artifact was found and fixed while linting:
`packages/server/src/server/agent/providers/omp/agent.test.ts` declared
`TURN_LIFECYCLE_EVENTS`, `isTurnLifecycle` and `ABORTED_TERMINAL_RESPONSE` twice.
The duplication is in `a2-area-app`'s own tree (`97083dd73` has one copy,
`a2-area-app` has two), it landed outside the conflict hunks, so no conflict
resolution could have caught it, and it fails lint rather than the build. The two
copies were byte-identical; removing the second leaves the file identical to
`97083dd73`. `vitest run src/server/agent/providers/omp/agent.test.ts`: 65 tests
pass.

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

**`deploy-website.yml` pnpm install — RE-APPLIED** (this branch). The only
workflow whose pnpm install path was still lost: `386e4fd4e` had
`pnpm/action-setup@v4`, `cache: pnpm`,
`cache-dependency-path: pnpm-lock.yaml` and
`pnpm install --frozen-lockfile`; the merged tree had upstream's
`npm-retry.mjs ci --workspace=@getpaseo/website --workspace=@getpaseo/protocol`
and `cache: "npm"`. Restored, keeping two newer upstream additions rather than
reverting them: the `packages/protocol/**` path trigger, and upstream's
`Build protocol` step. That step is load-bearing, not cosmetic —
`packages/protocol`'s only export condition is `./dist/*` and protocol has no
`prepare`/`prepublishOnly`, so pnpm does not build it on install and the website
typecheck cannot resolve `@getpaseo/protocol` without it.

Checked and left alone: `desktop-release.yml` and `desktop-rollout.yml` already
carry the fork's pnpm path (8 and 2 sites). `desktop-packages.yml`,
`android-apk-release.yml`, `nix.yml` and `nix-update-hash.yml` are identical in
`386e4fd4e`, `97083dd73` and this branch — they are upstream's and were never
fork pnpm work, so "re-applying" them would have been inventing a fork delta.

**`scripts/postinstall-patches.mjs` — RE-APPLIED** (this branch). The merged file
was byte-identical to upstream's, so the whole pnpm/bun-scoped repair was lost.
Recovered: a `packages/app/node_modules/react-native-svg` entry scoped to
`packages/app` (pnpm does not hoist it, and without the entry the SVG transform
hardening never applies and a CSS keyword transform throws at render time); a
`packages/freebuff-acp/node_modules/@codebuff/sdk` entry scoped to
`packages/freebuff-acp`; a root `node_modules/@opencode-ai/sdk` entry for bun
installs; a group-level `if (!existsSync(target)) continue;` so a patch group
only runs where its packages really exist; and an explicit `node_modules/.bin` on
`PATH` for the `patch-package` spawn, because bun lifecycle hooks do not add it
and every bun install silently skipped the patches. Verified live rather than by
inspection: after a clean frozen-lockfile install the postinstall log shows
`react-native-svg@15.15.3`, `@opencode-ai/sdk@1.18.23` and
`@codebuff/sdk@0.10.7` all patched.

**`workspace:*` convention — RE-APPLIED by running the script** (this branch).
`node scripts/sync-workspace-versions.mjs` reported 12 files. End state: **23
internal `@getpaseo/*` deps across the workspace, all `workspace:*`, zero
exceptions.** Five of them still needed rewriting (all in `packages/app`, from
`*`); the merges had already landed the other 18. See
[KEPT-VIA-SCRIPT](#kept-via-script) for why the version stamps that run also
produced were not committed.

**`msgpackr-extract` — KEPT** (`00f656e8e`). Already present in
`pnpm-workspace.yaml`'s `allowBuilds`, with the reason inline: pnpm 11 writes a
non-boolean `set this to true or false` placeholder for an unlisted build script
and the install aborts with `ERR_PNPM_IGNORED_BUILDS`. It installs prebuilt
per-platform binaries, so its script selects a prebuild rather than compiling.

### Workspace members added on this branch

Two packages shipped or built but sat outside the workspace, so nothing in CI
could see them.

**`plugins/` — ADDED.** The server build copies `plugins/` into
`dist/server/builtin-plugins`, so this code ships at runtime while escaping CI
typecheck and vitest entirely. Before the change `plugins/` was the only
workspace in the repo with no `node_modules` at all.

The unit is `plugins`, not `plugins/*`. Upstream ships the 11 builtin plugins
(`antigravity-provider`, `muse-provider`, and the claude/codex/copilot/cursor/
grok/kimi/minimax/opencode-go/zai usage-sources) as **one** package,
`@getpaseo/builtin-plugins`, with the plugin directories as plain subfolders of
it. A `plugins/*` glob would match nothing, because none of those
subdirectories has a `package.json`.

Membership alone was not enough, and the error counts are worth recording
because they are not what they look like:

| State                                                   | Errors |
| ------------------------------------------------------- | ------ |
| before membership — `node_modules` absent               | 2      |
| after membership, `dist` still stale                    | 181    |
| after `npm run build:server-deps`                       | 130    |
| after declaring the deps `plugins/package.json` omitted | 57     |
| after the `plugins/tsconfig.json` change below          | 12     |

The "before" figure of 2 is two `TS2688` "cannot find type definition file"
errors, which abort the program before any per-file checking. That is not a
small number; it is a typecheck that could not start. The brief expected 8 and
55 for `ctx-inject` and `trajectory` — those are the counts **after** membership
and a rebuild, and both are now **0**.

Two causes, both configuration:

1. `plugins/package.json` never declared what our fork plugins import. Added, at
   the versions `packages/plugin` and `packages/app` already pin:
   `@getpaseo/protocol` `workspace:*`, `@tanstack/react-query` `^5.90.11`,
   `react` `19.1.0`, `react-native` `0.81.5`, `@types/react` `~19.2.0` (dev).
   This cleared all 49 `TS2307` and the `TS2875`/`TS7006` errors cascading from
   them.
2. `plugins/tsconfig.json` contradicted the convention the ported plugins were
   written against. `tsconfig.base.json` is already `Bundler`; the umbrella
   overrode it to `NodeNext`, while `plugins/trajectory/tsconfig.json` — which
   sets `allowImportingTsExtensions` with the comment "The ported dsh modules
   import siblings as ./layout.ts" — assumes the base setting. Set the umbrella
   to `ESNext`/`Bundler` and added `allowImportingTsExtensions`. That cleared 25
   `TS2835` and trajectory's 5 `TS5097`. Safe because the config is `noEmit:
true`, so resolution strictness cannot affect emitted output. All 11 upstream
   builtin plugins stay at 0 under `Bundler`.

The 12 that remain are all in `plugins/freebuff` and are source-level, not
configuration, so they are recorded rather than fixed:

- 4x `TS2724` — `@getpaseo/plugin/client/ui` exports `SettingsAction`,
  `SettingsCard`, `SettingsGroup`, `SettingsInput`, `SettingsRow`,
  `SettingsSection`, `SettingsSwitch`, `SettingsSelect`. It does **not** export
  `SettingsIconButton` or `SettingsIconRow`, which `account-row.tsx`,
  `add-account.tsx` and `models-section.tsx` import. Upstream changed that
  surface; porting freebuff onto it is source work.
- 2x `TS2307` — freebuff imports `./generated` and `./server/generated`, which
  do not exist in the tree. A codegen artifact whose generator has not run.
- 6x `TS2769`/`TS2322`, downstream of the above.

**`packages/fleet-backend` — ADDED.** Merge 1 took `a2-area-ledger`'s root
`package.json`, which predates the paseo#31 fleet-backend work, so the package
dropped out of the npm `workspaces` array and CI stopped seeing it. Re-added
there. `pnpm-workspace.yaml`'s `packages/*` already matched it, so it needed no
pnpm-side change. **Configuration only: not one file inside
`packages/fleet-backend` was edited.** It belongs to the paseo#31 leader working
it in parallel. `npm run typecheck --workspace=@getpaseo/fleet-backend` exits 0
with 0 errors, which is the proof that the membership is CI-visible and harmless.

### Still dropped — fork infrastructure

Re-checked against this branch rather than left as written, because three of the
entries below were closed by work on this branch.

- **`.gitignore`** — still lost `/.deploy-production.lock` (`4f2b98137`) while
  `scripts/deploy-production.sh` still writes that lock (1 reference in the
  tree), so the lock file can be committed and collide with a concurrent deploy.
  Also still lost the `.mcp.json` ignore (`35741dda9`, `ec158eb9e`). Both
  confirmed absent from `.gitignore` on this branch. Not a pnpm concern; needs an
  owner.
- **metro-resolver declaration** — still absent. `packages/app/package.json`
  declares no metro resolver field, which pnpm's isolated hoisting needs. Not
  restored here because it is not a workspace-membership question and getting it
  wrong changes app bundling.
- **`release-version-utils.mjs` prerelease tolerance** — the fork loosened the
  beta-channel check to accept any prerelease suffix (`-hydra-…`, `-rc.1`,
  `-custom`), which is what lets the stamped versions in
  [KEPT-VIA-SCRIPT](#kept-via-script) parse. Reverted to upstream's stricter
  form, which throws on anything that is not `-beta.N`. Found while auditing
  `scripts/` and deliberately not re-applied: it is coupled to version stamping,
  not to the package manager, and shipping one half of that pair is how you get a
  release script that rejects its own stamps.

Resolved on this branch, previously listed here:

- **`.github/workflows/deploy-website.yml`** — was listed here as "deliberately
  untouched: on the do-not-touch list". That entry is now wrong: the pnpm install
  path is RE-APPLIED, see
  [Re-applied since](#re-applied-since--ci-and-the-package-manager). The do-not-touch
  call belonged to the upstream-first merge round, not to this one.
- **`workspace:*` specifiers** (`6d1afce38`) — all 23 internal `@getpaseo/*`
  deps are on `workspace:*`, produced by running the sync script.
- **`tsx` declarations** (`6f12c733e`, `4098ff877`) — root `tsx` is
  `devDependencies.tsx: ^4.21.0` and resolves from the repo root. Both merges
  reverted this at least once and it was restored each time; it is load-bearing
  because `npm run cli` shells `npx tsx packages/cli/src/index.js` and a
  root-spawned daemon needs `node --import tsx`.
  `packages/protocol`'s `jiti` was in the same position — declared at
  `386e4fd4e`, dropped by every area branch, restored here at `^2.7.0` — and no
  area branch had claimed it.
- **P0 SDK pin** — `@opencode-ai/sdk` is back at `1.18.23`, via `a2-area-runtime`.
  Upstream holds `1.14.46`, and merging `a2-area-server2` would have pulled it
  back down, so the pin was held explicitly through that merge.
  The earlier note about the orphaned guard test no longer holds: there is no
  `1.18.23` reference left in `event-consumer.test.ts`, so assert the gate's
  current behaviour rather than trusting that note.

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

| File                | Decision      | Why                                                                              |
| ------------------- | ------------- | -------------------------------------------------------------------------------- |
| `pnpm-lock.yaml`    | authoritative | the package manager this fork actually runs                                      |
| `package-lock.json` | deleted       | upstream's; restored by the merge resolving a modify/delete conflict to upstream |
| `bun.lock`          | deleted       | fork-only, nothing consumes it                                                   |

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

| Package                                  | manifest  | lockfile | why                    |
| ---------------------------------------- | --------- | -------- | ---------------------- |
| `packages/website` `react`               | `^19.1.4` | `19.1.0` | override pins `19.1.0` |
| `packages/website` `react-dom`           | `^19.1.4` | `19.1.0` | same                   |
| `packages/app` `react-native-reanimated` | `~4.3.1`  | `4.3.1`  | override pins `4.3.1`  |
| `packages/app` `react-native-worklets`   | `~0.8.3`  | `0.8.3`  | override pins `0.8.3`  |

The `react` pair is upstream's own arrangement, not a fork delta: `packages/
website` asks `^19.1.4` on the fork base, on upstream and at HEAD alike, while
upstream's **root** `package.json` pins `react` at exactly `19.1.0`. Our
override reproduces that root pin in pnpm's idiom. Nothing to reconcile.

**`lucide-react-native` — SUPERSEDED, and the report had it backwards.** Upstream
moved it from `0.x` to `1.x` in `d3c76be9c` ("Unify Explorer tabs and refine
launch controls", #5942). The fork base had `^0.546.0`; HEAD has `^1.50.0`,
which is what upstream carries and what the lockfile records. Taking upstream was
correct. The `^0.546.0` figure is what this fork _used_ to declare, not what the
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

## KEPT-VIA-SCRIPT

A class for behaviour that is **not** re-applied by hand during the merge,
because running a script reproduces it. It is a form of kept, not of lost.

Owner decision 2026-10-05: the fork's version stamping is kept. That is the
`-hub` fork identifier and `scripts/sync-workspace-versions.mjs`, covering 38 of
the 147 at-risk commits.

### What the script does

`scripts/sync-workspace-versions.mjs` is not a dropped path — it was never in
conflict, so it is intact at HEAD. Entry point is `version:sync-internal` in the
root `package.json`. It:

1. reads the root `package.json` version and strips a trailing `-hub`, so the
   identifier lives in the script rather than in the manifest field upstream owns;
2. derives `versionWithHash` as `<root>-hub-<short-hash>-<hydra-timestamp>`, or
   `<root>-hub` when no git hash is available;
3. rewrites every workspace `package.json` `version` to that string;
4. rewrites internal `@getpaseo/*` dependency ranges to exactly `workspace:*`;
5. writes each file it changed and logs either `Synced to <version>:` with the
   file list, or `Workspace versions and internal deps already synced to
<version>` when it had nothing to do.

Point 4 matters beyond stamping: it means the `workspace:*` convention discussed
under [Open decisions](#open-decisions) comes back **by running the script**,
not by hand-editing 20-odd manifests. That is the right shape for it, because the
script is the only thing that knows the current root version and hash.

### The version stamps are produced, not committed

Running the script on this branch changed two separate things: 5 dependency
rewrites, and the `version` field of all 12 manifests. Only the dependency
rewrites are committed.

The stamp is `<root>-hub-<short-git-hash>-<yyMMdd-hhmm>`. The hash and the clock
are in it, so a committed stamp is unique to the moment it was generated: it
bakes one merge SHA into twelve manifests, and every later run of the script is a
twelve-file diff again. That is noise on every merge, and it would resolve
conflicts in those twelve files constantly.

Nothing is lost by not committing it. The stamp is build output, and the fork
already produces it where it is actually consumed:

- `.github/workflows/paseo-manual-pipeline.yml` runs the script at two call sites
- `scripts/deploy-production.sh` runs it before building

So the behaviour survives without appearing in the tree, and the check that
matters is the one below: that the script runs, and that the tree it leaves is
self-consistent. `docs/fork/at-risk-commits.md` already records this class as
verification by execution rather than by diff.

One consequence worth stating: because the committed versions stay at upstream's
`0.11.0-beta.3`, `scripts/check-fork-version-stamp.mjs` reports PASS because it
stamps a throwaway replica and compares, not because the committed field is
stamped. Do not read that PASS as evidence that a stamp is committed.

### How the verification should prove it

The check cannot be "this diff was re-applied", because nothing re-applies it. It
has to establish that the script ran and left a self-consistent tree. The shape
it should take, for whoever implements it:

- `node scripts/sync-workspace-versions.mjs` exits 0.
- Its output is one of the two documented forms above. `Synced to <v>:` with a
  file list on a first run, `already synced to <v>` on a second.
- **Idempotence:** run it twice; the second run must report `already synced` and
  change nothing. This is the property that makes the class safe, and it is
  checkable without knowing the expected version up front.
- **Consistency:** after the run, every workspace `package.json` `version` equals
  the same stamped string, and differs from the root only by the `-hub` treatment
  the script documents.
- **Internal deps:** every `@getpaseo/*` range in every workspace manifest is
  exactly `workspace:*`.
- **Clean tree:** `git diff --exit-code` is empty afterwards, apart from the
  version files the script is entitled to write. A second run must produce no
  diff at all.

The verification procedure itself is implemented by a sibling agent and is not
edited here. This section describes the shape so the two agree.

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
_deleted_ silently undercounts — that is exactly how `package-lock.json` gets
missed, and it is the single most consequential entry in this ledger.
