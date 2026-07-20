import { describe, it, expect, beforeEach } from "vitest";
import {
  useBackgroundTaskStore,
  selectBackgroundTasksForAgent,
  refreshBackgroundTasks,
} from "./store";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";

const SERVER = "test-server";
const AGENT = "agent-1";

function makeTask(
  overrides: Partial<BackgroundTaskDescriptorPayload> = {},
): BackgroundTaskDescriptorPayload {
  return {
    id: "task-1",
    agentId: AGENT,
    toolName: "background_bash",
    command: "sleep 100",
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    outputPreview: null,
    ...overrides,
  };
}

describe("useBackgroundTaskStore", () => {
  beforeEach(() => {
    useBackgroundTaskStore.setState({ tasks: new Map() });
  });

  it("replaceList stores tasks sorted by startedAt", () => {
    const task2 = makeTask({ id: "task-2", startedAt: "2026-01-01T00:00:01.000Z" });
    const task1 = makeTask({ id: "task-1", startedAt: "2026-01-01T00:00:00.000Z" });

    useBackgroundTaskStore.getState().replaceList(SERVER, AGENT, [task2, task1]);

    const result = selectBackgroundTasksForAgent(useBackgroundTaskStore.getState(), SERVER, AGENT);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("task-1");
    expect(result[1].id).toBe("task-2");
  });

  it("applyUpdate upsert adds a new task", () => {
    const task = makeTask();
    useBackgroundTaskStore.getState().applyUpdate(SERVER, {
      kind: "upsert",
      task,
    });

    const result = selectBackgroundTasksForAgent(useBackgroundTaskStore.getState(), SERVER, AGENT);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("task-1");
    expect(result[0].status).toBe("running");
  });

  it("applyUpdate upsert updates existing task", () => {
    const task = makeTask();
    useBackgroundTaskStore.getState().applyUpdate(SERVER, { kind: "upsert", task });

    const updated = makeTask({
      id: "task-1",
      status: "completed",
      exitCode: 0,
      finishedAt: "2026-01-01T00:01:00.000Z",
    });
    useBackgroundTaskStore.getState().applyUpdate(SERVER, { kind: "upsert", task: updated });

    const result = selectBackgroundTasksForAgent(useBackgroundTaskStore.getState(), SERVER, AGENT);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("completed");
    expect(result[0].exitCode).toBe(0);
  });

  it("applyUpdate remove deletes a task", () => {
    const task = makeTask();
    useBackgroundTaskStore.getState().applyUpdate(SERVER, { kind: "upsert", task });
    useBackgroundTaskStore
      .getState()
      .applyUpdate(SERVER, { kind: "remove", agentId: AGENT, taskId: "task-1" });

    const result = selectBackgroundTasksForAgent(useBackgroundTaskStore.getState(), SERVER, AGENT);
    expect(result).toHaveLength(0);
  });

  it("selectBackgroundTasksForAgent returns empty array for unknown agent", () => {
    const result = selectBackgroundTasksForAgent(
      useBackgroundTaskStore.getState(),
      SERVER,
      "unknown",
    );
    expect(result).toEqual([]);
  });

  it("replaceList for different agents are independent", () => {
    const taskA = makeTask({ id: "task-a", agentId: "agent-A" });
    const taskB = makeTask({ id: "task-b", agentId: "agent-B" });

    useBackgroundTaskStore.getState().replaceList(SERVER, "agent-A", [taskA]);
    useBackgroundTaskStore.getState().replaceList(SERVER, "agent-B", [taskB]);

    expect(
      selectBackgroundTasksForAgent(useBackgroundTaskStore.getState(), SERVER, "agent-A"),
    ).toHaveLength(1);
    expect(
      selectBackgroundTasksForAgent(useBackgroundTaskStore.getState(), SERVER, "agent-B"),
    ).toHaveLength(1);
  });

  it("replaceList replaces previous tasks", () => {
    const old = makeTask({ id: "old" });
    useBackgroundTaskStore.getState().replaceList(SERVER, AGENT, [old]);
    expect(
      selectBackgroundTasksForAgent(useBackgroundTaskStore.getState(), SERVER, AGENT),
    ).toHaveLength(1);

    const fresh = makeTask({ id: "fresh" });
    useBackgroundTaskStore.getState().replaceList(SERVER, AGENT, [fresh]);
    const result = selectBackgroundTasksForAgent(useBackgroundTaskStore.getState(), SERVER, AGENT);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("fresh");
  });
});

describe("refreshBackgroundTasks", () => {
  beforeEach(() => {
    useBackgroundTaskStore.setState({ tasks: new Map() });
  });

  it("calls listBackgroundTasks and populates store", async () => {
    const task1 = makeTask({ id: "bg-1" });
    const task2 = makeTask({ id: "bg-2", status: "completed" });

    const client = {
      listBackgroundTasks: async () => ({
        requestId: "req-1",
        agentId: AGENT,
        tasks: [task1, task2],
        error: null,
      }),
    };

    await refreshBackgroundTasks(client as never, SERVER, AGENT);

    const result = selectBackgroundTasksForAgent(useBackgroundTaskStore.getState(), SERVER, AGENT);
    expect(result).toHaveLength(2);
  });

  it("deduplicates concurrent requests for the same agent", async () => {
    let callCount = 0;
    const client = {
      listBackgroundTasks: async () => {
        callCount++;
        return { requestId: "req-1", agentId: AGENT, tasks: [], error: null };
      },
    };

    await Promise.all([
      refreshBackgroundTasks(client as never, SERVER, AGENT),
      refreshBackgroundTasks(client as never, SERVER, AGENT),
    ]);

    expect(callCount).toBe(1);
  });
});
