import { DatabaseSync } from "node:sqlite";
import { TrajectoryEventSchema, type TrajectoryEvent } from "../shared/events.js";
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
      const seq = Number(result.lastInsertRowid);
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
      let where = "agent_id = ?";
      if (opts.afterSeq !== undefined) {
        where += " AND seq > ?";
        params.push(opts.afterSeq);
      }
      params.push(opts.limit);
      const stmt = db.prepare(
        `SELECT seq, time, type, turn, step, agent_id AS agentId, data
         FROM trajectory_events
         WHERE ${where}
         ORDER BY seq ASC
         LIMIT ?`,
      );
      const rows = stmt.all(...(params as never[])) as unknown as RawRow[];
      return rows.map(toEvent);
    },

    close() {
      // Idempotent: wiring cleanup and test teardown may both close.
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
