# Upstream contribution candidates

Fork features that look like they belong upstream, prepared so the owner can
decide whether to propose them.

> **No pull request exists.** Nothing here has been pushed anywhere, no upstream
> repository has been contacted, and no PR has been opened. These are written-up
> candidates only. The owner approves any external contact separately. A reader
> arriving here should not assume a PR is in flight, and should not open one on
> the strength of this file.

Baseline every candidate was built against: **`97083dd73`** (upstream/main as of
the integration merge, merge commit `921702068` on this branch).

---

## Candidate 1 — background task tracking

**Owner decision 2026-10-05: "to upstream".** Nothing is dropped for this; the
implementation stays in the merge while the protocol side is restored by the
server area.

### What the feature is

Paseo agents can run work that outlives a single foreground call — a long tool
run, a queued subagent, a background provider operation. This feature makes that
state **visible and queryable** rather than invisible:

- the server tracks in-flight background operations per agent, and exposes them
  over the WebSocket API as `agent.background_tasks.list`;
- the client caches the list and the app renders it, first as a panel row and
  then as a composer-toolbar icon button, so a user can see that an agent is
  still doing something after the turn that started it has returned.

The capability is advertised in `client-capabilities.ts`, so a host that lacks it
is detectable and the UI can degrade rather than break.

### Which of our commits compose it

| Commit | Date | Role |
| --- | --- | --- |
| `01ab14e01` | 2026-07-20 | the feature: protocol, client, server, app store and track UI |
| `01b888d06` | 2026-07-22 | moves the surface from a panel row to a composer icon button |
| `4e33e7b2d` | 2026-08-26 | one-line brace fix in the agent-manager intercept, from a bad merge |

All three are among the 147 at-risk commits and are classified **RE-APPLIED**.
`4e33e7b2d` is a repair of a merge regression rather than new work, but it belongs
to the same file and hunks, so it travels with the feature.

### Exact files and hunks

`01ab14e01` — 15 files, +942/−4:

| File | Δ | Role |
| --- | --- | --- |
| `packages/protocol/src/messages.ts` | +61 | the `agent.background_tasks.list` request/response pair |
| `packages/protocol/src/client-capabilities.ts` | +3 | advertises the capability |
| `packages/client/src/daemon-client.ts` | +32 | client method for the list RPC |
| `packages/server/src/server/agent/agent-manager.ts` | +205 | tracks background operations, `listBackgroundTasks` |
| `packages/server/src/server/session.ts` | +28 | routes the RPC |
| `packages/server/src/server/websocket-server.ts` | +2 | dispatch registration |
| `packages/server/src/server/pid-lock.ts` | +10 | background ops must not hold the pid lock |
| `packages/app/src/background-tasks/store.ts` | +105 | client-side cache |
| `packages/app/src/background-tasks/store.test.ts` | +167 | store tests |
| `packages/app/src/background-tasks/select.ts` | +38 | selector over the store |
| `packages/app/src/background-tasks/track.tsx` | +227 | the row/track renderer |
| `packages/app/src/background-tasks/index.ts` | +6 | module surface |
| `packages/app/src/components/agent-status-dot.tsx` | +37 | indicates work in flight |
| `packages/app/src/contexts/session-context.tsx` | +7 | wires the store into session scope |
| `packages/app/src/panels/agent-panel.tsx` | +18 | hosts the first presentation |

`01b888d06` — 3 files, +249/−8:

| File | Δ | Role |
| --- | --- | --- |
| `packages/app/src/background-tasks/icon-button.tsx` | +204 | the composer icon button |
| `packages/app/src/composer/index.tsx` | +44 | mounts it in the composer toolbar |
| `packages/app/src/panels/agent-panel.tsx` | +9 | removes the superseded row |

`4e33e7b2d` — 1 file, +1: the missing brace in the `agent-manager.ts` intercept.

### Current state in our tree

The app side survived the upstream-first merge intact — `store.ts`, `track.tsx`,
`icon-button.tsx` and `select.ts` are all present, and the composer still wires
the surface. The protocol and server side did **not**: `messages.ts` has zero
`background_tasks` references and `agent-manager.ts` has no `listBackgroundTasks`,
because both files were resolved to upstream. That asymmetry is the direct cause
of the 19 compile errors catalogued in [delta.md](delta.md#what-is-broken-right-now)
(cause A). The server area is restoring the protocol branch; this candidate
assumes that lands.

### Why it is upstreamable

The problem is not fork-specific. Any user of an agent that keeps working after
the turn returns has the same blind spot: the UI says the turn is done while the
agent is still running, and there is no way to ask what it is doing. Today the
only signal is the terminal scrollback. This makes the state explicit and
queryable, and it does it in a way that is safe on an old host — the capability
flag means a client can tell the difference between "no background work" and
"this host cannot tell me".

It is also a natural fit for the protocol's existing shape: it is a
request/response list RPC plus a capability bit, which is the pattern upstream
already uses for comparable per-agent state.

### What would change for upstream style

- **Tests.** `store.test.ts` is the only test in the set, and it is the app store,
  not the feature. Upstream would expect coverage on the server side —
  `AgentManager` background tracking, the RPC handler in `session.ts`, and the
  capability advertisement. The RPC pair in `messages.ts` would also want a
  contract test of the shape the app store assumes.
- **Docs.** `docs/agent-lifecycle.md` and `docs/glossary.md` would need the new
  agent state and the RPC name. This fork's glossary rule is that a UI label wins
  and synonyms are forbidden, so the state needs one name agreed before the doc
  is written.
- **Naming.** `agent.background_tasks.list` follows the dotted-namespacing rule
  with a direction suffix, so it should already be acceptable, but the *state*
  name needs checking against upstream's existing vocabulary — this fork may have
  called it something upstream spells differently, and the UI label is what has
  to match.
- **Deprecation markers.** None needed: the capability flag is additive and an
  old client simply does not send the RPC. Worth stating explicitly in the PR,
  because it is the question a reviewer asks first.
- **Scope.** `4e33e7b2d` is a merge-repair commit against a fork branch. It should
  not be contributed as a commit — the brace should simply be correct in the
  squashed version of `01ab14e01`.

### Open questions for the owner

- Does the owner want this as one squashed PR, or protocol/server first and app
  second so the RPC can land and be adopted independently?
- Upstream has no `background_tasks` surface at `97083dd73`. Whether it wants one
  at all is upstream's call, and this file does not presume the answer.

---

## Considered and not listed

- **Freebuff** — dropped by owner decision, `freebuff no longer used`. It is a
  fork product with a fork-specific account and quota model, and there is nothing
  in it that generalises. Not a candidate.
- **Version stamping** (`-hub` identifier, `scripts/sync-workspace-versions.mjs`) —
  kept, and explicitly a fork-maintenance concern. `delta.md` records how it is
  verified. Not a candidate.
- **pnpm CI scoping and lockfile rulings** — these are decisions about *this*
  fork's release flow, not a feature upstream would want. Not candidates.
