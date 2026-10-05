/**
 * migrate-ledger.mjs — M3a: orchestration.sqlite (Python ledger) -> fleet.db (Turso).
 *
 * WHY THIS IS COMMITTED RATHER THAN THROWAWAY
 *   The dry run that proved the cutover used a script I then deleted. The swap script
 *   that depended on it therefore performed NO migration at all, and
 *   `fleet-backend.service` would have opened a NON-EXISTENT fleet.db, let Turso create
 *   an empty one, and served an EMPTY orchestration ledger while every structural smoke
 *   check still returned 200. This file is that missing step.
 *
 * SAFETY
 *   - Reads the Python ledger; never opens it for writing.
 *   - Refuses to write to an existing target unless --force, so a re-run cannot
 *     silently double-apply.
 *   - The GLOBAL ORPHAN SCAN runs first and is a HARD GATE. Python ran with
 *     PRAGMA foreign_keys=0, so deleting a track never cascaded and never blocked;
 *     fleet-backend enforces FKs, so a reference Python tolerated for a month aborts
 *     the migration. This scan is what proves a given instance has only the orphans
 *     handled below.
 *   - Any per-table count mismatch exits non-zero.
 *
 * USAGE (run from packages/fleet-backend, after `npm run build`)
 *   node scripts/migrate-ledger.mjs --source <orchestration.sqlite> --target <fleet.db> [--force]
 *
 * The reconstructed row is DATA, not logic: the values live in RECONSTRUCTED below and
 * are used verbatim. `goal` was not recoverable from any surviving row, and `goal` is
 * `TEXT NOT NULL` in BOTH schemas, so it carries an explicit unrecoverable marker rather
 * than invented prose.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import * as path from "node:path";
import { connect } from "@tursodatabase/database";

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const source = argOf("source");
const target = argOf("target");
const force = argv.includes("--force");

if (!source || !target) {
  console.error(
    "usage: node scripts/migrate-ledger.mjs --source <orchestration.sqlite> --target <fleet.db> [--force]",
  );
  process.exit(2);
}

/** Owner-supplied reconstruction. Values used verbatim; never re-derived. */
const RECONSTRUCTED = {
  "t-8d42fb7e63": {
    id: "t-8d42fb7e63",
    project_id: "p-7719544617",
    epic: "712-713-recovery", // track_created payload
    repo: "ddvnguyen/hydra_vortex", // track_created payload
    branch: "epic-712", // track_created payload
    status: "archived", // track_closed payload — NOT "closed"
    handoff: "superseded by mcp-orchestration p2 track; W1 74ffeaf0 continues independently",
    goal: "[unrecoverable: original track row missing; goal lost with it — reconstructed during M3a from surviving events]",
    leader_binding: JSON.stringify({
      agent_id: "57747c50-08c6-48a8-9442-aeaa0b92a134", // LAST leader_registered 2026-09-02T14:25:06.163Z
      model: "opencode-go/glm-5.3-flash",
      contract_version: "2.2.0",
      verified: true,
    }),
    heartbeats: "[]",
    overrides: "[]",
    overrides_provenance:
      "M3a migration 2026-10-05: RECONSTRUCTED from this track's own events after the original row " +
      "was found missing from `tracks`. epic/repo/branch from track_created; status/handoff from " +
      "track_closed (2026-09-02T14:39:42.675Z); leader_binding from the LAST leader_registered; " +
      "created_at/updated_at from event timestamps; turn_count=9 (the REAL count — track_closed " +
      "recorded 7 at close time and turns 8 and 9 landed after closure). `goal` was UNRECOVERABLE. " +
      "Root cause of the orphan: Python ran with PRAGMA foreign_keys=0, so the delete never cascaded.",
    turn_count: 9,
    created_at: "2026-09-02T12:47:39.030Z",
    updated_at: "2026-09-03T07:38:06.492Z",
  },
};

const MAP = [
  ["projects", "orch_projects"],
  ["tracks", "orch_tracks"],
  ["tasks", "orch_tasks"],
  ["workers", "orch_workers"],
  ["turns", "orch_turns"],
  ["events", "orch_events"],
  ["decisions", "orch_decisions"],
  ["suggestions", "orch_suggestions"],
  ["model_evaluations", "orch_model_evaluations"],
];
const CHILD_TRACK_FK = ["tasks", "workers", "turns", "events", "decisions"];

const die = (msg) => {
  console.error(`MIGRATION ABORTED: ${msg}`);
  process.exit(1);
};

// --- 1. global orphan scan (standing gate) ---------------------------------
console.log("== global orphan scan ==");
const src = new DatabaseSync(source, { readOnly: true });
const trackIds = new Set(
  src
    .prepare("SELECT id FROM tracks")
    .all()
    .map((r) => r.id),
);
const projectIds = new Set(
  src
    .prepare("SELECT id FROM projects")
    .all()
    .map((r) => r.id),
);

const danglingTracks = new Set();
for (const t of CHILD_TRACK_FK) {
  for (const r of src
    .prepare(`SELECT DISTINCT track_id FROM ${t} WHERE track_id IS NOT NULL AND track_id <> ''`)
    .all()) {
    if (!trackIds.has(r.track_id)) danglingTracks.add(r.track_id);
  }
}
const danglingProjects = new Set();
for (const t of ["tracks", "suggestions"]) {
  for (const r of src
    .prepare(
      `SELECT DISTINCT project_id FROM ${t} WHERE project_id IS NOT NULL AND project_id <> ''`,
    )
    .all()) {
    if (!projectIds.has(r.project_id)) danglingProjects.add(r.project_id);
  }
}
console.log(
  `  dangling tracks:   ${danglingTracks.size ? [...danglingTracks].sort().join(", ") : "(none)"}`,
);
console.log(
  `  dangling projects: ${danglingProjects.size ? [...danglingProjects].sort().join(", ") : "(none)"}`,
);

if (danglingProjects.size > 0) {
  die(
    `dangling project reference(s): ${[...danglingProjects].join(", ")}. A project row cannot be ` +
      `reconstructed from children — fix the source ledger first.`,
  );
}
const unhandled = [...danglingTracks].filter((id) => !(id in RECONSTRUCTED));
if (unhandled.length > 0) {
  die(
    `unhandled orphan track(s): ${unhandled.join(", ")}. Every dangling parent must be handled ` +
      `deliberately in RECONSTRUCTED, or this migration must fail.`,
  );
}

// --- 2. target selection --------------------------------------------------
// Decided BEFORE connecting: opening a database creates it, so a guard placed
// after connect() can never fire for a non-existent target.
if (existsSync(target) && !force) {
  die(`${target} already exists — pass --force to overwrite (replaced, never merged)`);
}
if (force && existsSync(target)) {
  // --force means OVERWRITE, not "skip the guard". Appending into an existing
  // target left a half-populated database that died on the first UNIQUE
  // constraint — an earlier version of this file claimed to replace and did
  // not. Remove the database AND its WAL/SHM siblings, or the stale WAL is
  // replayed into the fresh file.
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${target}${suffix}`;
    if (existsSync(p)) {
      rmSync(p, { force: true });
      console.log(`  removed ${p}`);
    }
  }
}

const schema = await import("../dist/store/schema.js");
const db = await connect(target);
db.defaultSafeIntegers(true);
await db.exec(schema.FLEET_SCHEMA_SQL);

const norm = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Uint8Array) return Buffer.from(v);
  return v;
};

let failures = 0;
for (const [from, to] of MAP) {
  const rows = src.prepare(`SELECT * FROM ${from}`).all();
  for (const row of rows) {
    const cols = Object.keys(row);
    await db.run(
      `INSERT INTO ${to} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      cols.map((c) => norm(row[c])),
    );
  }
  let extra = 0;
  if (from === "tracks") {
    for (const id of danglingTracks) {
      const rec = RECONSTRUCTED[id];
      const cols = Object.keys(rec);
      await db.run(
        `INSERT INTO ${to} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        cols.map((c) => rec[c]),
      );
      console.log(
        `  reconstructed ${id} (turn_count=${rec.turn_count}, goal marked unrecoverable)`,
      );
      extra += 1;
    }
  }
  const after = await db.get(`SELECT count(*) AS n FROM ${to}`);
  const n = Number(after.n ?? 0);
  const ok = n === rows.length + extra;
  if (!ok) failures++;
  console.log(
    `${from} -> ${to}: source=${rows.length}${extra ? ` +${extra} reconstructed` : ""} target=${n} ${ok ? "OK" : "MISMATCH"}`,
  );
}

for (const row of src
  .prepare("SELECT version, applied_at FROM schema_version ORDER BY version")
  .all()) {
  await db.run(
    "INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)",
    `schema_version:${row.version}`,
    String(row.applied_at ?? ""),
  );
  console.log(`  schema_version ${row.version} (applied ${row.applied_at}) -> meta`);
}

await db.close();
src.close();
console.log(failures === 0 ? "MIGRATION OK" : `MIGRATION FAILED: ${failures} table mismatch(es)`);
console.log(`target: ${path.resolve(target)}`);
process.exit(failures === 0 ? 0 : 1);
