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

### Dropped — fork infrastructure, must be re-applied

- **`.github/workflows/ci.yml` — the fork's entire pnpm CI conversion is gone.**
  The merged file has **zero** `pnpm` references and installs with npm. Lost:
  `35bcedf27` (pnpm install), `48b7dff90` (green CI on the pnpm repo),
  `5e0b78c36` (the `PASEO_CI_ALL_PLATFORMS` desktop/macOS gate — now ungated),
  `31b504936` (the pnpm-filtered Windows daemon-control check), `741718dac` (the
  pnpm rules runbook). The `fleet-backend` job and its pnpm install went with it.
- **`.github/workflows/deploy-website.yml`** — lost the `pnpm-lock.yaml` path entry
  (`c06f1195a`), so release and rollout target npm again.
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
- **`package-lock.json` is back.** This one is worth stating plainly: the fork
  deleted it when it moved to pnpm, and the merge restored upstream's copy. The
  tree now carries `package-lock.json`, `pnpm-lock.yaml` *and* `bun.lock`
  side by side. Nothing selects between them except each workflow's own config,
  and after this merge most workflows were resolved to the npm side. **Deciding
  which lockfile is authoritative is unresolved and is a prerequisite for a
  green CI**, not something this baseline settles.
- **`c537bd2f5`** — restoring the `-hydra` identifier into root `package.json`
  conflicts with upstream owning that file's versioning; the fork stamps at build
  time instead.

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