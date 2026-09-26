import type {
  BackgroundTaskDescriptorPayload,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { create } from "zustand";

type BackgroundTaskUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "agent.background_tasks.update" }
>["payload"];

interface BackgroundTaskState {
  tasks: Map<string, BackgroundTaskDescriptorPayload[]>;
  replaceList(serverId: string, agentId: string, tasks: BackgroundTaskDescriptorPayload[]): void;
  applyUpdate(serverId: string, payload: BackgroundTaskUpdatePayload): void;
}

function taskListKey(serverId: string, agentId: string): string {
  return `${serverId}\0${agentId}`;
}

export const useBackgroundTaskStore = create<BackgroundTaskState>((set) => ({
  tasks: new Map(),
  replaceList(serverId, agentId, tasks) {
    set((state) => {
      const key = taskListKey(serverId, agentId);
      const tasksMap = new Map(state.tasks);
      tasksMap.set(
        key,
        [...tasks].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
      );
      return { tasks: tasksMap };
    });
  },
  applyUpdate(serverId, payload) {
    set((state) => {
      if (payload.kind === "upsert") {
        const { task } = payload;
        const key = taskListKey(serverId, task.agentId);
        const existing = state.tasks.get(key) ?? [];
        const idx = existing.findIndex((t) => t.id === task.id);
        const next = [...existing];
        if (idx >= 0) {
          next[idx] = task;
        } else {
          next.push(task);
        }
        next.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        const tasksMap = new Map(state.tasks);
        tasksMap.set(key, next);
        return { tasks: tasksMap };
      }
      // remove
      const { agentId, taskId } = payload;
      const key = taskListKey(serverId, agentId);
      const existing = state.tasks.get(key);
      if (!existing) return state;
      const next = existing.filter((t) => t.id !== taskId);
      const tasksMap = new Map(state.tasks);
      tasksMap.set(key, next);
      return { tasks: tasksMap };
    });
  },
}));

type BackgroundTaskListClient = Pick<DaemonClient, "listBackgroundTasks">;

const pendingListRequests = new WeakMap<BackgroundTaskListClient, Map<string, Promise<void>>>();

export function refreshBackgroundTasks(
  client: BackgroundTaskListClient,
  serverId: string,
  agentId: string,
): Promise<void> {
  const requestKey = `${serverId}\0${agentId}`;
  let clientRequests = pendingListRequests.get(client);
  if (!clientRequests) {
    clientRequests = new Map();
    pendingListRequests.set(client, clientRequests);
  }
  const pending = clientRequests.get(requestKey);
  if (pending) return pending;

  const request = client
    .listBackgroundTasks(agentId)
    .then((payload) => {
      useBackgroundTaskStore.getState().replaceList(serverId, agentId, payload.tasks);
      return undefined;
    })
    .finally(() => {
      clientRequests?.delete(requestKey);
    });
  clientRequests.set(requestKey, request);
  return request;
}

export function selectBackgroundTasksForAgent(
  state: ReturnType<typeof useBackgroundTaskStore.getState>,
  serverId: string,
  agentId: string,
): BackgroundTaskDescriptorPayload[] {
  const key = taskListKey(serverId, agentId);
  return state.tasks.get(key) ?? [];
}
