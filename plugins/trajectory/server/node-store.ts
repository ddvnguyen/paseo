import { DatabaseSync } from "node:sqlite";
import { TrajectoryEventSchema, type TrajectoryEvent } from "../shared/trajectory.js";
import type { ListByAgentOptions, TrajectoryEventInput, TrajectoryStore } from "./store.js";

/**
 * Zero-dependency driver on Node's builtin SQLite. Writes are synchronous,
 * which is acceptable for a single plugin subprocess with small volumes.
 */

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS trajectory_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  time TEXT NOT NULL,
  type TEXT NOT NULL,
  turn TEXT,
  step INTEGER,
  agent_id TEXT,
  data TEXT NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_trajectory_events_agent ON trajectory_events(agent_id, seq)`,
] as const;

const SCHEMA_SQL = SCHEMA_STATEMENTS.join(";\n") + ";";

/** Raw row shape exactly as sqlite returns it, including the camelCase alias. */
interface RawRow {
  seq: number | bigint;
  time: string;
  type: string;
  turn: string | null;
  step: number | null;
  agentId: string | null;
  data: string;
}

function parseData(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toEvent(row: RawRow): TrajectoryEvent {
  return TrajectoryEventSchema.parse({
    seq: Number(row.seq),
    time: row.time,
    type: row.type,
    turn: row.turn,
    step: row.step === null ? null : Number(row.step),
    // Explicit alias `agent_id AS agentId` in the SELECT keeps this defined
    // (reference finding 1: snake_case columns must not be cast as camelCase).
    agentId: row.agentId,
    data: parseData(row.data),
  });
}

export function createNodeStore(path: string): TrajectoryStore {
  const db = new DatabaseSync(path);
  let closed = false;
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);

  const insert = db.prepare(
    `INSERT INTO trajectory_events (time, type, turn, step, agent_id, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  return {
    append(input: TrajectoryEventInput): TrajectoryEvent {
      const result = insert.run(
        input.time,
        input.type,
        input.turn,
        input.step,
        input.agentId,
        JSON.stringify(input.data),
      );
      // `run()` returns the driver's info object; the shim types it as unknown,
      // so read the one field this store needs through a narrow local shape.
      const info = result as { lastInsertRowid?: number | bigint } | undefined;
      const seq = Number(info?.lastInsertRowid ?? 0);
      return {
        seq,
        time: input.time,
        type: input.type,
        turn: input.turn,
        step: input.step,
        agentId: input.agentId,
        data: input.data,
      };
    },

    listByAgent(agentId: string, opts: ListByAgentOptions): TrajectoryEvent[] {
      const params: unknown[] = [agentId];
      const bounds: string[] = ["agent_id = ?"];
      if (opts.afterSeq !== undefined) {
        bounds.push("seq > ?");
        params.push(opts.afterSeq);
      }
      params.push(opts.limit);
      // Tail-first: the inner query takes the NEWEST `limit` matching rows, and
      // the outer query re-sorts them ascending. Both halves are load-bearing.
      // The inner ORDER BY decides WHICH rows come back; the outer one decides
      // the order the client folds them in. Returning the inner order verbatim
      // would hand the fold a newest-first page and mis-pair tool/call with
      // tool/result, because events-to-rows.ts never sorts.
      const stmt = db.prepare(
        `SELECT seq, time, type, turn, step, agent_id AS agentId, data FROM (
           SELECT seq, time, type, turn, step, agent_id, data
           FROM trajectory_events
           WHERE ${bounds.join(" AND ")}
           ORDER BY seq DESC
           LIMIT ?
         ) ORDER BY seq ASC`,
      );
      const rows = stmt.all(...(params as never[])) as unknown as RawRow[];
      return rows.map(toEvent);
    },

    headSeq(agentId: string): number {
      const stmt = db.prepare("SELECT MAX(seq) AS head FROM trajectory_events WHERE agent_id = ?");
      const row = stmt.get(agentId) as { head: number | bigint | null } | undefined;
      const head = row?.head;
      return head === null || head === undefined ? 0 : Number(head);
    },

    close() {
      // Idempotent: wiring cleanup and test teardown may both close.
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
