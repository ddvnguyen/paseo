import type { TrajectoryEvent } from "../shared/events.js";

/** A new ledger row: everything except the database-assigned `seq`. */
export type TrajectoryEventInput = Omit<TrajectoryEvent, "seq">;

export interface ListByAgentOptions {
  /** Return events with `seq` strictly greater than this (paging cursor). */
  afterSeq?: number;
  /** Maximum number of rows to return. */
  limit: number;
}

/**
 * Persistence seam behind the trajectory ledger.
 *
 * `seq` is assigned by the database (`INTEGER PRIMARY KEY AUTOINCREMENT`), so
 * it is unique, monotonic, and survives restarts with no in-memory counter
 * and no seeding (reference findings 1 and 6 fixed by construction).
 */
export interface TrajectoryStore {
  /** Insert one row; returns the stored event including its assigned `seq`. */
  append(input: TrajectoryEventInput): TrajectoryEvent;
  /** Ascending-`seq` page of one agent's events; `data` is parsed JSON. */
  listByAgent(agentId: string, opts: ListByAgentOptions): TrajectoryEvent[];
  close(): void;
}
