import type { PluginRpcContract } from "@getpaseo/plugin";
import type { z } from "zod";
import {
  TRAJECTORY_PAGE_LIMIT_DEFAULT,
  trajectoryChanges,
  trajectoryList,
  trajectorySubscribe,
} from "../shared/trajectory.js";
import type { TrajectoryStore } from "./store.js";

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
  input: { agentId: string; afterSeq?: number; limit?: number },
): { events: ReturnType<TrajectoryStore["listByAgent"]>; headSeq: number } {
  return {
    events: store.listByAgent(input.agentId, {
      afterSeq: input.afterSeq,
      limit: input.limit ?? TRAJECTORY_PAGE_LIMIT_DEFAULT,
    }),
    headSeq: store.headSeq(input.agentId),
  };
}

export function handleList(
  store: TrajectoryStore,
): (input: z.input<ListContract["input"]>) => Promise<z.input<ListContract["output"]>> {
  return async (input) => readPage(store, input);
}

export function handleChanges(
  store: TrajectoryStore,
): (input: z.input<ChangesContract["input"]>) => Promise<z.input<ChangesContract["output"]>> {
  return async (input) => readPage(store, input);
}

export function handleSubscribe(
  store: TrajectoryStore,
): (input: z.input<SubscribeContract["input"]>) => Promise<z.input<SubscribeContract["output"]>> {
  return async (input) => readPage(store, input);
}

export type {
  ListContract,
  ChangesContract as ChangesContractType,
  SubscribeContract as SubscribeContractType,
  PluginRpcContract,
};
