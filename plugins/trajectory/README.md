# Trajectory plugin

Agent trajectory ledger: a sequenced event log (`{seq, time, type, turn, step, agentId, data}`)
recorded from daemon lifecycle hooks and agent timeline streams, plus (T1/T2) RPCs and a
dsh-style ledger UI. Plugin-only — no core paseo edits (upstream-merge-safe).

## Layout

| Path                   | Owns                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `shared/events.ts`     | `TrajectoryEventSchema` envelope (zod) — the only wire contract so far                  |
| `server/store.ts`      | `TrajectoryStore` interface; `seq` is DB-assigned (`INTEGER PRIMARY KEY AUTOINCREMENT`) |
| `server/node-store.ts` | node:sqlite driver; camelCase rows via SQL aliases; `data` JSON-parsed                  |
| `server/recorder.ts`   | pure recorder: paseo events -> ledger rows (turn attribution, dedupe)                   |
| `server/wiring.ts`     | idempotent lazy stream attach; one recorder+store per plugin process                    |
| `index.server.ts`      | hook registration; every callback calls `ensureAttached(paseo)` first                   |

## Tests

`plugins/` is not a pnpm workspace member, so bare imports (`zod`, `vitest/config`) do not
resolve from this directory. `vitest.config.ts` aliases them through
`packages/plugin/node_modules`. Run tests from this directory:

```bash
cd plugins/trajectory
../../packages/plugin/node_modules/.bin/vitest run server/node-store.test.ts
```

Never run the repo's full test suite (repo rule, CLAUDE.md).

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
