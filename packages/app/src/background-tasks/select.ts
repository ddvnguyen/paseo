import { useEffect } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import equal from "fast-deep-equal";
import { useSessionStore } from "@/stores/session-store";
import {
  refreshBackgroundTasks,
  selectBackgroundTasksForAgent,
  useBackgroundTaskStore,
} from "./store";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";

export function useBackgroundTasksForAgent(
  serverId: string,
  agentId: string,
): BackgroundTaskDescriptorPayload[] {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.backgroundTasks === true,
  );

  const tasks = useStoreWithEqualityFn(
    useBackgroundTaskStore,
    (state) => selectBackgroundTasksForAgent(state, serverId, agentId),
    equal,
  );

  useEffect(() => {
    if (!client || !supported || !agentId) return;
    void refreshBackgroundTasks(client, serverId, agentId).catch(() => undefined);
  }, [client, serverId, agentId, supported]);

  return tasks;
}

export function useBackgroundTaskCountForAgent(serverId: string, agentId: string): number {
  const tasks = useBackgroundTasksForAgent(serverId, agentId);
  return tasks.filter((t) => t.status === "running").length;
}
