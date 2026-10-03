# Trajectory plugin

Agent trajectory ledger: a sequenced event log (`{seq, time, type, turn, step, agentId, data}`)
recorded from daemon lifecycle hooks and agent timeline streams, plus (T1/T2) RPCs and a
dsh-style ledger UI. Plugin-only — no core paseo edits (upstream-merge-safe).

## Layout

| Path                         | Owns                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `shared/trajectory.ts`       | `TrajectoryEventSchema` envelope + `list`/`changes`/`subscribe` RPC contracts + snapshot schemas (zod) |
| `server/store.ts`            | `TrajectoryStore` interface; `seq` is DB-assigned (`INTEGER PRIMARY KEY AUTOINCREMENT`)                |
| `server/node-store.ts`       | node:sqlite driver; camelCase rows via SQL aliases; `data` JSON-parsed                                 |
| `server/recorder.ts`         | pure recorder: paseo events -> ledger rows (turn attribution, dedupe)                                  |
| `server/injected-context.ts` | harness-injected context: daemon `appendSystemPrompt` sampling + the staged-create queue               |
| `server/wiring.ts`           | idempotent lazy stream attach; one recorder+store per plugin process                                   |
| `index.server.ts`            | hook registration; every callback calls `ensureAttached(paseo)` first                                  |

## Tests

`plugins/` is not a pnpm workspace member, so bare imports (`zod`, `vitest/config`) do not
resolve from this directory. `vitest.config.ts` aliases them through
`packages/plugin/node_modules`. Run tests from this directory:

```bash
cd plugins/trajectory
../../packages/plugin/node_modules/.bin/vitest run server/node-store.test.ts
```

Never run the repo's full test suite (repo rule, CLAUDE.md).

## Injected context rows (`system/attach`)

Two rows land in the turn-less preamble bucket, told apart by `data.source`:

| `source`         | What it is                                                       | `correlated`       |
| ---------------- | ---------------------------------------------------------------- | ------------------ |
| absent (=caller) | the `systemPrompt` the caller configured, seen on `agent.create` | `config` or `fifo` |
| `daemon-append`  | the instructions the daemon appends to every session             | `time-window`      |

The daemon's own append is the awkward one. `daemonAppendSystemPrompt` lives
only on the server-internal `AgentSessionConfig` and is deliberately never
persisted, and the daemon applies it _after_ `before("agent.create")` runs
(`createAgentInternal` awaits the hook, then calls `prepareSessionConfig` →
`applyDaemonAppendSystemPrompt`). No hook payload and no stream event carries
it, so there is no per-agent observation of it to be had. The plugin samples
`paseo.config.get()` inside the create instead, and the row says
`time-window` because the setting is global: the read and the injection share
one create, and a config patch landing mid-create would make the pairing wrong
in a way nothing observable can rule out.

Both rows are length + a 12-char sha256 prefix over the _trimmed_ text the
daemon actually injects. Never the text (d-893c722f28).

`server/injected-context.ts` owns the sampling and the staged-create queue, so
the pairing is testable without a store or a client. The queue is bounded
(`MAX_STAGED_CREATES`) because any create with a daemon append stages an entry,
and an entry whose agent never appears would otherwise leak.

Not observable, so not recorded: `AGENTS.md`/`CLAUDE.md` and any other file the
harness reads at launch. No hook exposes what a provider loaded, and a plugin
cannot read an agent's workspace files. A row claiming otherwise would be
fabricated.

## Row timing

A row's own duration is what the recorder measured, not what the fold inferred:

- **Tool rows** carry `tool/result.data.durationMs` — wall time from the call
  to the result — and are stamped at the **call** time. The stamp is the call
  because the duration already spans call→result: anchored on the result, every
  tool reads as a row that started when it finished, and the group wall span
  (which folds `absTime + ownDuration`) lands a full duration late. dsh anchors
  its tool cell at `callTime` for the same reason. The span comes from the
  recorder's own clock, not from two ledger stamps — it times the call and
  subtracts when the result lands — and the panel's `timing source` line says so.
- **Message and thinking rows** carry the span across the run's stream events, so
  they grow as the response streams and stop growing when it ends.
- **A result whose call was never observed** gets a backfilled call row, so its
  stamp is the reconstruction instant rather than a real start. The recorder
  flags those rows (`data.backfilled`); nothing renders the flag yet.
- **An unanswered call is the only open row**, and the only row that shows a
  running time that ticks. A settled row keeps the duration it took: the ledger
  records one real duration per fact, and a clock that keeps counting after a
  row finished would report time the row did not take. Same reason no timer runs
  at all while nothing is open. That live number is read from the VIEWER's clock
  (the daemon's stamp is the starting point), so a device whose clock is ahead
  reads high — there is no upper bound to clamp against, because the honest
  expected duration is exactly what is not known yet.
- The timeline strip above the list does not tick: an open call's bar stays
  zero-width until its result lands.

Still unmeasured, and rendered as the em dash rather than a guess: a message the
provider emitted in a single event (no span to measure), a tool call outside any
open turn (the recorder has no call time to subtract from), and TTFT, generation
time and decode throughput — no provider event says when the first token of a
response arrived. The detail view names which field is missing instead of showing
a number.

## Reference bugs fixed by construction (paseo-fleet review, d-03af302129)

1. snake_case columns cast as camelCase -> explicit SQL aliases (`agent_id AS agentId`), tested.
2. Stream recorder attached once at init when `paseoApi` was undefined -> `ensureAttached`
   is idempotent and called at the top of every hook callback and RPC handler.
3. Tool rows on a phantom synthetic turn -> explicit turnId, else the agent's open turn,
   else `turn=null`. Never a fabricated turn.
4. `terminatedTurnKeys` dropped later terminals -> per-agent open-turn list; first terminal
   wins per turn id, later turns of the same agent are unaffected.
5. Hook fallback duplicated tool rows -> dedupe on `agentId+callId+phase`; replay-safe.
6. In-memory seq + seeding -> seq is DB-assigned and monotonic across restarts; queries are
   cursor-paged (`afterSeq`).
