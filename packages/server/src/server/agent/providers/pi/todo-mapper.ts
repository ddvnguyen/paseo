import { z } from "zod";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type { PiSessionState } from "./rpc-types.js";
import type { PiToolResult } from "./tool-call-mapper.js";

const PiTodoItemSchema = z
  .object({
    content: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "abandoned"]),
  })
  .passthrough();
const PiTodoPhaseSchema = z
  .object({ name: z.string(), tasks: z.array(PiTodoItemSchema) })
  .passthrough();

type PiTodoItem = z.infer<typeof PiTodoItemSchema>;
type PiTodoPhase = z.infer<typeof PiTodoPhaseSchema>;

export function mapPiTodoToolResult(result: PiToolResult): AgentTimelineItem | null {
  const phases = resultDetails(result)?.phases;
  const parsed = PiTodoPhaseSchema.array().safeParse(phases);
  return parsed.success ? mapPiTodoPhases(parsed.data) : null;
}

export function mapPiTodoState(state: PiSessionState): AgentTimelineItem[] {
  const parsed = PiTodoPhaseSchema.array().safeParse(state.todoPhases);
  if (!parsed.success) {
    return [];
  }
  const item = mapPiTodoPhases(parsed.data);
  return item ? [item] : [];
}

function mapPiTodoPhases(phases: readonly PiTodoPhase[]): AgentTimelineItem | null {
  const todos = phases.flatMap((phase) => phase.tasks);
  return mapPiTodoItems(todos);
}

function mapPiTodoItems(items: readonly PiTodoItem[]): AgentTimelineItem | null {
  if (items.length === 0) {
    return null;
  }
  return {
    type: "todo",
    items: items.map((item) => ({
      text: item.content,
      status: normalizePiTodoStatus(item.status),
      completed: item.status === "completed",
    })),
  };
}

function normalizePiTodoStatus(status: PiTodoItem["status"]) {
  if (status === "completed") return "completed" as const;
  if (status === "in_progress") return "in_progress" as const;
  return "pending" as const;
}

function resultDetails(result: PiToolResult): Record<string, unknown> | null {
  if (typeof result === "string" || result === null) {
    return null;
  }
  return isRecord(result.details) ? result.details : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
