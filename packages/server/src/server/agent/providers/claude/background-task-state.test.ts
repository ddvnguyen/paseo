import { describe, expect, test } from "vitest";

import { ClaudeBackgroundTaskState } from "./background-task-state.js";

function taskStarted(taskId: string, description: string, taskType = "subagent"): unknown {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    description,
    task_type: taskType,
    uuid: "u-1",
    session_id: "s-1",
  };
}

function backgroundTasksChanged(
  tasks: { task_id: string; task_type: string; description: string }[],
): unknown {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks,
    uuid: "u-2",
    session_id: "s-1",
  };
}

function taskNotification(
  taskId: string,
  status: "completed" | "failed" | "stopped",
  summary: string,
): unknown {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status,
    output_file: `/tmp/${taskId}.log`,
    summary,
    uuid: "u-3",
    session_id: "s-1",
  };
}

describe("ClaudeBackgroundTaskState", () => {
  test("tracks task_started and completes via task_notification", () => {
    const state = new ClaudeBackgroundTaskState();

    const started = state.observe(taskStarted("task-1", "run the build"));
    expect(started).not.toBeNull();
    expect(started?.tasks).toHaveLength(1);
    expect(started?.tasks[0]).toMatchObject({
      id: "task-1",
      toolName: "subagent",
      command: "run the build",
      status: "running",
      finishedAt: null,
    });

    const completed = state.observe(taskNotification("task-1", "completed", "build finished"));
    expect(completed).not.toBeNull();
    expect(completed?.tasks[0]).toMatchObject({
      id: "task-1",
      status: "completed",
      command: "build finished",
      finishedAt: expect.any(String),
    });
  });

  test("dedupes unchanged snapshots", () => {
    const state = new ClaudeBackgroundTaskState();
    const first = state.observe(taskStarted("task-1", "run tests"));
    expect(first).not.toBeNull();
    const second = state.observe(taskStarted("task-1", "run tests"));
    expect(second).toBeNull();
  });

  test("level signal replaces membership and enriches from edges", () => {
    const state = new ClaudeBackgroundTaskState();
    const seeded = state.observe(
      backgroundTasksChanged([{ task_id: "t1", task_type: "bash", description: "dev server" }]),
    );
    expect(seeded?.tasks[0]).toMatchObject({ id: "t1", status: "running", command: "dev server" });
    // task_started for the same task carries the same description: no snapshot change.
    expect(state.observe(taskStarted("t1", "dev server", "bash"))).toBeNull();
    const removed = state.observe(backgroundTasksChanged([]));
    expect(removed?.tasks).toHaveLength(0);
  });

  test("task_notification maps stopped to cancelled", () => {
    const state = new ClaudeBackgroundTaskState();
    state.observe(taskStarted("task-2", "long task"));
    const stopped = state.observe(taskNotification("task-2", "stopped", "cancelled by user"));
    expect(stopped?.tasks[0].status).toBe("cancelled");
  });

  test("reset clears tracked tasks", () => {
    const state = new ClaudeBackgroundTaskState();
    state.observe(taskStarted("task-1", "run"));
    state.reset();
    expect(state.observe(taskNotification("task-1", "completed", "done"))).toBeNull();
  });

  test("failed notification marks task failed", () => {
    const state = new ClaudeBackgroundTaskState();
    state.observe(taskStarted("task-3", "deploy"));
    const failed = state.observe(taskNotification("task-3", "failed", "deploy failed"));
    expect(failed?.tasks[0].status).toBe("failed");
  });
});
