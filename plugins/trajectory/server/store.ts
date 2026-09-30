import type { TrajectoryEvent } from "../shared/trajectory.js";

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
  /** Newest seq for an agent, or 0 when it has no rows (pagination cursor). */
  headSeq(agentId: string): number;
  /**
   * Whether the ledger already holds a tool call/result for this call.
   *
   * The recorder's in-memory dedupe set only survives inside one process run,
   * so a restart or a re-attach would happily re-write a replayed call. This is
   * the durable half: it answers from the rows themselves, which is what makes
   * replay-safe dedupe possible at all. Optional because a store without it (an
   * in-memory fake, a test double) simply gets in-memory-only dedupe.
   */
  hasToolPhase?(agentId: string, callId: string, phase: "call" | "result"): boolean;
  close(): void;
}
