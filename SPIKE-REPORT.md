# SPIKE-REPORT: B2 — Mastra Memory spike (task-493dbf2ddc)

Branch: `spike/mastra-memory` (private; DO NOT push, DO NOT open a PR).
Base: `origin/Paseo-hub` 8b107acb6. packages/fleet-backend untouched.
Spike package: `packages/fleet-backend-spike-mastra/` (sibling of fleet-backend;
keeps volatile `@mastra/*` out of the shipped package.json even on rebase).
Tests: `packages/fleet-backend-spike-mastra/src/no-llm-proof.test.ts` (3 passing).
Installed: `@mastra/memory@1.35.0`, `@mastra/turso@0.1.12`, `@mastra/core@1.74.0`
(peer), `@mastra/libsql@1.25.0` (turso dep), `@tursodatabase/database@0.7.0`
(turso dep; fleet-backend itself pins 0.7.2).

**Lock constraint honored:** `@mastra/*` added ONLY on this spike branch, ONLY
in the sibling package. This branch MUST be dropped/rebased before any
Paseo-hub merge. The root `pnpm-lock.yaml` diff is a side effect of the scoped
install; it is not staged for any merge.

## Item 1 — Connection rule / merge-safety rule 2: CONDITIONAL GO (adapter required)

Driver actually used: `@mastra/turso@0.1.12` uses **`@tursodatabase/database@0.7.0`**
— NOT `@libsql/client`, NOT remote/sync. Evidence:
`node_modules/.pnpm/@mastra+turso@0.1.12_.../node_modules/@mastra/turso/dist/index.js:209`
(`const { connect } = await import("@tursodatabase/database")`),
`:210` (`const db = await connect(config.path, {...})`),
`:218` (`db.defaultSafeIntegers(true)`), `:294`
(`TursoStore extends LibSQLStore`, imported at `:1`).
Manifest: `.../@mastra/turso/package.json:22-25`
(`"dependencies": { "@tursodatabase/database": "0.7.0", ...,
"@mastra/libsql": "1.25.0" }`).

`client` option EXISTS. `.../@mastra/turso/dist/index.d.ts:15-27`:
`TursoStoreConfig = Base & ({ path: string; client?: never; ... } |
{ client: SqliteClient; path?: never })`. Ctor branch at `dist/index.js:296-313`:
`if ("client" in config && config.client) client = config.client; else`
opens its own file via `new TursoSqliteClient({ path ... })`.

BUT fleet's raw `Database` is NOT assignable: the accepted type is
`SqliteClient` (`.../@mastra/libsql/dist/storage/db/client.d.ts:16-30`:
`execute/batch/transaction/close/closed/protocol`). A thin adapter (~40 lines)
wrapping the TursoRepository `Database` (`db.batch`, transaction,
`db.close`) in `execute/batch/transaction/close/closed/protocol` is required;
Turso's own `TursoSqliteClient` (`dist/index.js:106-252`) is the template
(normalize statement/args + `normalizeResult`, own AsyncMutex).

Rule-2 note: the gate (`scripts/fleet-merge-safety.mjs:62-80`) scans ONLY
`packages/fleet-backend` first-party files and allows exactly one importer
(`src/store/turso-repository.ts`); today `node ... --check-turso-only` =
PASS. A `SqliteClient` adapter placed inside fleet-backend's `domain/team/`
module would NOT import `@tursodatabase/database` itself (it consumes the
`Database` handle), so rule 2 still passes — but the adapter file + its
`SqliteClient` import is a NEW file the gate must keep allowing; confirm in
review. Path-mode (Mastra opening its own `fleet.db` connection) is the
alternative and is a NO: two independent writers bypass the in-process
mutex + `BEGIN IMMEDIATE` + `busy_timeout=0` + cooperative-retry design
(`turso-repository.ts:189-249`, lock at `:264-343`); the second connection
gets `SQLITE_BUSY` outside fleet's retry loop (Mastra has its own
maxRetries/backoff: `LibSQLStore` ctor defaults `maxRetries=5`,
`initialBackoffMs=100` at `.../@mastra/libsql/dist/index.js:14620-14640`,
observably different contention behavior) and can interleave with fleet's
`SAVEPOINT` nesting.

GO iff: client-mode with a `SqliteClient` adapter owned by
`turso-repository.ts` (adapter constructed there, passed down), never
path-mode against `fleet.db`.

## Item 2 — No-LLM path: GO (proven)

Passing vitest: `packages/fleet-backend-spike-mastra/src/no-llm-proof.test.ts`
(3/3 green, ~0.5s): `TursoStore({ id, path })` file mode + `store.init()` +
`new Memory({ storage: store, options: { workingMemory: { enabled: true,
scope: "thread", schema } } })` with zod schema
`{ handoff, working_notes, conventions, open_questions }` —
then `createThread` / `updateWorkingMemory` / `getWorkingMemory` with NO
model, NO Agent, NO embedder configured. Run:
`cd packages/fleet-backend-spike-mastra && ./node_modules/.bin/vitest run`
→ `Test Files 1 passed, Tests 3 passed`.

Why no model is needed: `Memory.updateWorkingMemory` (storage write path at
`.../@mastra/memory/dist/src-CPCWMt3d.js:33456-33500`) only calls
`getMergedThreadConfig`, a per-scope `Mutex`, then
`memoryStore.updateResource` (resource scope) or `patchThread` metadata
write (thread scope) — no model/embedder reference on that path. The LLM
lives one layer up: schema-mode merge (`deepMergeWorkingMemory` at
`:23495-23512`, wired into the `updateWorkingMemoryTool` at `:23535-23656`
behind `usesMergeSemantics = Boolean(schema)` at `:23573`) runs inside the
agent tool call, NOT inside `updateWorkingMemory` itself.

## Item 3 — Cost: GO (license clean; weight is native prebuilds + core peer)

| package                                             | version | license (`package.json`) |
| --------------------------------------------------- | ------- | ------------------------ |
| `@mastra/memory`                                    | 1.35.0  | Apache-2.0               |
| `@mastra/turso`                                     | 0.1.12  | Apache-2.0               |
| `@mastra/core` (peer)                               | 1.74.0  | Apache-2.0               |
| `@mastra/libsql` (turso dep)                        | 1.25.0  | Apache-2.0               |
| `@tursodatabase/database` (turso dep; MIT carrier)  | 0.7.0   | MIT                      |
| `libsql` (via `@libsql/client@0.18.0`; MIT carrier) | 0.5.29  | MIT                      |

| path (`.pnpm` real dir)                                             | size                                   |
| ------------------------------------------------------------------- | -------------------------------------- |
| `.../@mastra/memory`                                                | 11M                                    |
| `.../@mastra/turso`                                                 | 120K                                   |
| `.../@mastra/core`                                                  | 76M                                    |
| `.../@mastra/libsql`                                                | 3.5M                                   |
| `.../@tursodatabase+database-linux-x64-gnu@0.7.0` (native prebuild) | 93M (`turso.linux-x64-gnu.node`, 97MB) |
| `.../@libsql+linux-x64-gnu@0.5.29` (native prebuild)                | 9.3M (`index.node`, 9.7MB)             |

Transitive deps: `@mastra/memory` itself light (8 runtime deps:
`async-mutex, diff, json-schema, lru-cache, probe-image-size, xxhash-wasm,
zod, @mastra/schema-compat`); weight via `@mastra/core` peer (~28 runtime
deps incl. ai-sdk provider shims, hono, posthog, ws); `@mastra/turso` pulls
`@tursodatabase/database 0.7.0 + detect-libc + @mastra/libsql → @libsql/client
0.18.0 → libsql 0.5.29`. Note version skew: turso dep pins
`@tursodatabase/database@0.7.0` while fleet-backend pins `0.7.2` — pnpm keeps
both native trees; align before adoption.

Native prebuilds: NO node-gyp/link-time compile on linux x64 — both native
carriers ship prebuilt `.node` (napi-rs turso, neon libsql) as optional
per-platform packages. BUT `.../@mastra/turso/dist/index.js:261-291`
(`getTursoDatabaseSupport`) allows ONLY darwin-arm64, win32-x64, linux
x64/arm64+glibc — musl (Alpine/Docker) and other arches throw at construct
time. Fleet's Docker story (`docs/docker.md`) must stay glibc.

Verdict: license GO; size (~190M store weight, mostly prebuilds + core)
acceptable for a daemon, flagged for mobile/edge if ever bundled there.

## Item 4 — Ownership / merge / history: GO with our-layer enforcement

Merge semantics (measured): `deepMergeWorkingMemory(existing, update)`
(`.../@mastra/memory/dist/src-CPCWMt3d.js:23484-23512`):
primitives overwritten; objects merged recursively; **arrays replaced
entirely**; `update === null` **DELETES the key**; `undefined` skipped.
So a writer CAN clobber/delete a sibling block (`{ handoff: null }` deletes
`handoff`) — proven by test 3 (rival full-replace overwrites `handoff`).
And `updateWorkingMemory` itself is full-replace at storage
(`:33456-33500` → `updateResource` overwrites the `workingMemory` column:
`.../@mastra/libsql/dist/index.js:8502-8530`); merge ONLY happens if the
caller (agent tool path at `:23600-23656`) reads-modifies-writes first.
Two concurrent writers = last-write-wins, no conflict detection
(Memory has only a per-scope in-process `Mutex` at `:33467-33469`, nothing
cross-process).

Per-field authority: NONE in Mastra. `readOnly` hits (`grep`:
`:29770, :32564-32576, :32707, :33835, :34448`) are all whole-memory /
request-context flags (`memoryConfig.readOnly` → read-only instruction
rendering / skip observation writes), never per-field ACL/owner/lock —
no `owner/authority/lock/permission` primitive on working-memory blocks.

Version history: NONE for working memory. No
`workingMemoryHistory/memory_version/workingMemoryVersion` symbols in
`@mastra/memory` dist. Versioned tables that DO exist
(`mastra_agent_versions`, `mastra_prompt_block_versions`,
`mastra_skill_versions`, `mastra_workspace_versions`,
`mastra_mcp_*_versions`, `mastra_dataset_versions`,
`mastra_scorer_definition_versions`) cover OTHER domains, not working
memory. `mastra_messages` retains prompt history but not block-level
edit audit.

GO iff: per-block single-writer authority + append-only audit table live in
OUR layer (fleet `domain/team/`): serialize writes per block through our
lock, merge-then-write via `deepMergeWorkingMemory` (exported from
`@mastra/memory`: `dist/index.d.ts:21`), record every write in our audit
table. Mastra stores the blob; we own who may touch which field and the
history.

## Item 5 — Tables Mastra creates: GO (no collision)

Measured by real `TursoStore.init()` against a scratch file (44 tables;
45th name `mastra_traces` is a declared constant with no LibSQL DDL —
observability tracing table created only by other backends). Canonical
constants: `.../@mastra/core/dist/constants-C28271T_.js:1027-1071`
(`TABLE_*` → `mastra_*`); memory-domain DDL:
`.../@mastra/libsql/dist/index.js:7864-7916`
(`MemoryLibSQL.init`: `mastra_threads`, `mastra_messages`,
`mastra_resources`, `mastra_observational_memory` + 2 indexes);
thread-state DDL at `:12864-12869` (`mastra_thread_state`).

Full created list (all `mastra_*` prefix; zero `orch_*` / `traj_*` /
`team_*` / `schema_migrations`): mastra_agent_versions, mastra_agents,
mastra_ai_spans, mastra_background_tasks, mastra_channel_config,
mastra_channel_installations, mastra_dataset_items, mastra_dataset_versions,
mastra_datasets, mastra_experiment_results, mastra_experiments,
mastra_favorites, mastra_harness_sessions, mastra_knowledge_activity,
mastra_knowledge_cursors, mastra_knowledge_mentions, mastra_knowledge_nodes,
mastra_knowledge_records, mastra_knowledge_semantic_outbox,
mastra_mcp_client_versions, mastra_mcp_clients, mastra_mcp_server_versions,
mastra_mcp_servers, mastra_messages, mastra_notifications,
mastra_observational_memory, mastra_prompt_block_versions,
mastra_prompt_blocks, mastra_resources, mastra_schedule_triggers,
mastra_schedules, mastra_scorer_definition_versions,
mastra_scorer_definitions, mastra_scorers, mastra_skill_blobs,
mastra_skill_versions, mastra_skills, mastra_thread_state, mastra_threads,
mastra_tool_provider_connections, mastra_workflow_definitions,
mastra_workflow_snapshot, mastra_workspace_versions, mastra_workspaces.

Caveat (not a collision, but scope): default `store.init()` creates ALL
~24 domain stores' tables (LibSQLStore ctor at
`.../@mastra/libsql/dist/index.js:14620-14700` fans one client into
scores/workflows/memory/knowledge/...; `initDomainsInParallel/Sequentially`
at `:14736-14763`), NOT just the 4 memory tables. Adoption should either
accept ~44 dormant tables in `fleet.db` or bypass `TursoStore.init()` and
DDL only the memory domain (describe in the adoption plan; NOT done here —
fleet-backend untouched per spike rules).

No `schema_migrations` table from Mastra (grep: zero hits in
`@mastra/libsql` dist) — fleet's `meta.schema_version` scheme is unaffected.

## Overall adoption verdict: CONDITIONAL GO

All 5 items GO, with three conditions carried into the adoption plan:

1. client-mode `SqliteClient` adapter owned by `turso-repository.ts`; never a
   second `connect()` on `fleet.db` (item 1).
2. Per-block single-writer + append-only audit in OUR layer; Mastra is the
   blob store (item 4).
3. Decide full-`init()` (~44 tables) vs memory-domain-only DDL; pin
   `@tursodatabase/database` 0.7.0-vs-0.7.2 skew; Docker stays glibc (items
   3/5).
