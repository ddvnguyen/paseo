import type { AgentBackgroundTaskDescriptor, AgentTimelineItem } from "../../agent-sdk-types.js";

type BackgroundTaskStatus = AgentBackgroundTaskDescriptor["status"];

interface TrackedBackgroundTask {
  id: string;
  toolName: string;
  description: string | null;
  status: BackgroundTaskStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toIso(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTaskStatus(status: unknown): BackgroundTaskStatus | undefined {
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return status;
  }
  if (status === "stopped" || status === "killed") {
    return "cancelled";
  }
  return undefined;
}

function readDescription(value: unknown): string | null {
  return toIso(value) ?? null;
}

/**
 * Accumulates Claude's background-task signals (the SDK's `background_tasks_changed`
 * level signal plus the `task_started`/`task_progress`/`task_notification` edge
 * bookends, and `run_in_background` Bash tool uses) into canonical snapshot items.
 *
 * `background_tasks_changed` carries REPLACE semantics: swap the whole set for the
 * payload. Edge messages carry the metadata (`description`, terminal status) that the
 * level signal omits, so we merge bookend metadata onto the level signal's ids. The
 * snapshot is only emitted when it changes, matching how task-state.ts dedupes todo
 * snapshots at the agent boundary.
 */
export class ClaudeBackgroundTaskState {
  private readonly tasks = new Map<string, TrackedBackgroundTask>();
  private lastSnapshot: Extract<AgentTimelineItem, { type: "background_task" }> | null = null;

  observe(value: unknown): Extract<AgentTimelineItem, { type: "background_task" }> | null {
    const message = record(value);
    if (!message) return null;
    const subtype = string(message.subtype);
    const changed = this.applyLevelSignal(message, subtype);
    const edge = this.applyEdgeSignal(message, subtype);
    return changed || edge ? this.snapshot() : null;
  }

  reset(): void {
    this.tasks.clear();
    this.lastSnapshot = null;
  }

  private applyLevelSignal(message: Record<string, unknown>, subtype: string | undefined): boolean {
    if (subtype !== "background_tasks_changed") return false;
    const rawTasks = message.tasks;
    if (!Array.isArray(rawTasks)) return false;
    const liveIds = new Set<string>();
    for (const raw of rawTasks) {
      const task = record(raw);
      if (!task) continue;
      const id = string(task.task_id) ?? string(task.id);
      if (!id) continue;
      liveIds.add(id);
      const description = string(task.description) ?? string(task.summary) ?? null;
      const existing = this.tasks.get(id);
      if (existing) {
        this.tasks.set(id, {
          ...existing,
          status: "running",
          finishedAt: null,
          exitCode: null,
          ...(description ? { description } : {}),
        });
      } else {
        this.tasks.set(id, {
          id,
          toolName: string(task.task_type) ?? "background",
          description,
          status: "running",
          startedAt: new Date().toISOString(),
          finishedAt: null,
          exitCode: null,
        });
      }
    }
    for (const id of this.tasks.keys()) {
      if (!liveIds.has(id) && this.tasks.get(id)?.status === "running") {
        this.tasks.delete(id);
      }
    }
    return true;
  }

  private applyEdgeSignal(message: Record<string, unknown>, subtype: string | undefined): boolean {
    if (subtype === "task_started") {
      const id = string(message.task_id);
      if (!id) return false;
      const existing = this.tasks.get(id);
      this.tasks.set(id, {
        id,
        toolName: string(message.task_type) ?? string(message.subagent_type) ?? "background",
        description: readDescription(message.description),
        status: "running",
        startedAt: existing?.startedAt ?? new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
      });
      return true;
    }
    if (subtype === "task_progress") {
      const id = string(message.task_id);
      if (!id) return false;
      const existing = this.tasks.get(id);
      if (!existing) return false;
      const description = readDescription(message.description) ?? toIso(message.summary);
      this.tasks.set(id, {
        ...existing,
        ...(description ? { description } : {}),
      });
      return true;
    }
    if (subtype === "task_notification") {
      const id = string(message.task_id);
      const status = normalizeTaskStatus(message.status);
      if (!id || !status) return false;
      const existing = this.tasks.get(id);
      if (!existing) return false;
      this.tasks.set(id, {
        ...existing,
        status,
        finishedAt: new Date().toISOString(),
        ...(message.summary && typeof message.summary === "string"
          ? { description: message.summary }
          : {}),
      });
      return true;
    }
    if (subtype === "run_in_background") {
      return false;
    }
    return false;
  }

  private snapshot(): Extract<AgentTimelineItem, { type: "background_task" }> | null {
    const tasks: AgentBackgroundTaskDescriptor[] = [...this.tasks.values()]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((task) => ({
        id: task.id,
        agentId: "",
        toolName: task.toolName,
        command: task.description,
        status: task.status,
        startedAt: task.startedAt,
        finishedAt: task.finishedAt,
        exitCode: task.exitCode,
        outputPreview: null,
      }));
    const item: Extract<AgentTimelineItem, { type: "background_task" }> = {
      type: "background_task",
      tasks,
    };
    if (this.lastSnapshot && sameSnapshot(this.lastSnapshot, item)) {
      return null;
    }
    this.lastSnapshot = item;
    return item;
  }
}

function sameSnapshot(
  a: Extract<AgentTimelineItem, { type: "background_task" }>,
  b: Extract<AgentTimelineItem, { type: "background_task" }>,
): boolean {
  if (a.tasks.length !== b.tasks.length) return false;
  return a.tasks.every((task, index) => {
    const other = b.tasks[index];
    return (
      other?.id === task.id &&
      other.status === task.status &&
      other.command === task.command &&
      other.finishedAt === task.finishedAt
    );
  });
}
