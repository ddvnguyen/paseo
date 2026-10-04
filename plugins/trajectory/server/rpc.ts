import type { PluginRpcContract } from "@getpaseo/plugin";
import type { z } from "zod";
import {
  TRAJECTORY_PAGE_LIMIT_DEFAULT,
  trajectoryChanges,
  trajectoryList,
  trajectorySubscribe,
} from "../shared/trajectory.js";
import type { ListByAgentOptions, TrajectoryStore } from "./store.js";

/**
 * Read handlers. `trajectory.list` is the initial paged read;
 * `trajectory.changes` is the delta poll the client uses after its
 * `afterSeq` cursor (push-style refresh without polling intervals).
 * `trajectory.subscribe` is the push-reserved name: it serves the same paged
 * read today so the contract is callable and tested; live fan-out happens at
 * the recorder's onAppend hub, and a future push transport keeps this
 * payload shape unchanged.
 */

type ListContract = typeof trajectoryList;
type ChangesContract = typeof trajectoryChanges;
type SubscribeContract = typeof trajectorySubscribe;

function readPage(
  store: TrajectoryStore,
  // `z.input` types `limit` as optional because the schema carries a default;
  // readPage is the hand-off point, so the same default is applied here rather
  // than trusting a value the caller never sent.
  input: { agentId: string; afterSeq?: number; beforeSeq?: number; limit?: number },
  // Which end of the window to take. A property of the CALL, not of the
  // cursor: `list` opens at the head of the ledger, `changes` walks forward
  // from it, and they want opposite ends of the same window.
  direction: ListByAgentOptions["direction"],
): { events: ReturnType<TrajectoryStore["listByAgent"]>; headSeq: number } {
  const events = store.listByAgent(input.agentId, {
    afterSeq: input.afterSeq,
    beforeSeq: input.beforeSeq,
    limit: input.limit ?? TRAJECTORY_PAGE_LIMIT_DEFAULT,
    direction,
  });
  // `headSeq` describes the page that was just returned, so it is the page's
  // own last seq. Asking the store for MAX(seq) instead runs a second query
  // that can disagree with the first: rows written between the page SELECT and
  // the MAX(seq) read fall in that gap, the client adopts the newer cursor,
  // and those rows are then unreachable by any `seq > afterSeq` poll. Derived
  // from the page, the cursor can only ever name a row the client holds.
  //
  // An empty page reports the cursor the caller sent: no rows means no
  // progress, so the cursor must not move (0 for a fresh read, which is the
  // only way a first page is legitimately empty).
  const headSeq = events.length > 0 ? events[events.length - 1].seq : (input.afterSeq ?? 0);
  return { events, headSeq };
}

export function handleList(
  store: TrajectoryStore,
): (input: z.input<ListContract["input"]>) => Promise<z.input<ListContract["output"]>> {
  // "newest": the initial open shows the head of the ledger, so a full page
  // must not be spent on its oldest events.
  return async (input) => readPage(store, input, "newest");
}

export function handleChanges(
  store: TrajectoryStore,
): (input: z.input<ChangesContract["input"]>) => Promise<z.input<ChangesContract["output"]>> {
  // "oldest": the forward drain steps from the cursor one page at a time.
  // Taking the newest rows above the cursor instead would consume a backlog
  // from the end and strand its middle.
  return async (input) => readPage(store, input, "oldest");
}

export function handleSubscribe(
  store: TrajectoryStore,
): (input: z.input<SubscribeContract["input"]>) => Promise<z.input<SubscribeContract["output"]>> {
  // Payload-identical to `changes`, so it follows `changes` in direction too.
  return async (input) => readPage(store, input, "oldest");
}

export type {
  ListContract,
  ChangesContract as ChangesContractType,
  SubscribeContract as SubscribeContractType,
  PluginRpcContract,
};
