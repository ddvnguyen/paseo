import type { TrajectoryEvent } from "../shared/trajectory.js";

/** A new ledger row: everything except the database-assigned `seq`. */
export type TrajectoryEventInput = Omit<TrajectoryEvent, "seq">;

export interface ListByAgentOptions {
  /** Return events with `seq` strictly greater than this (paging cursor). */
  afterSeq?: number;
  /**
   * Return events with `seq` strictly less than this (reverse paging cursor).
   * Combined with the tail-first page below, this is what makes history older
   * than one page reachable at all.
   */
  beforeSeq?: number;
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
  /**
   * Ascending-`seq` page of one agent's events; `data` is parsed JSON.
   *
   * Tail-first: the page is the NEWEST `limit` rows matching the bounds, then
   * returned ascending. A live ledger is watched at its head, so a full page
   * must not spend its budget on the oldest events. The order matters as much
   * as the selection — `client/events-to-rows.ts` folds in arrival order and
   * never sorts, and a newest-first page would mis-pair `tool/call` with
   * `tool/result`.
   */
  listByAgent(agentId: string, opts: ListByAgentOptions): TrajectoryEvent[];
  /** Newest seq for an agent, or 0 when it has no rows. */
  headSeq(agentId: string): number;
  close(): void;
}
