import type { PluginRpcContract } from "@getpaseo/plugin";
import type { z } from "zod";
import { trajectoryChanges, trajectoryList } from "../shared/trajectory.js";
import type { TrajectoryStore } from "./store.js";

/**
 * Read handlers. `trajectory.list` is the initial paged read;
 * `trajectory.changes` is the delta poll the client uses after its
 * `afterSeq` cursor (push-style refresh without polling intervals).
 */

type ListContract = typeof trajectoryList;
type ChangesContract = typeof trajectoryChanges;

function readPage(
  store: TrajectoryStore,
  input: { agentId: string; afterSeq?: number; limit: number },
): { events: ReturnType<TrajectoryStore["listByAgent"]>; headSeq: number } {
  return {
    events: store.listByAgent(input.agentId, {
      afterSeq: input.afterSeq,
      limit: input.limit,
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

export type { ListContract, ChangesContract as ChangesContractType, PluginRpcContract };
