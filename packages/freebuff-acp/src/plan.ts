import type { Plan, PlanEntry } from "@agentclientprotocol/sdk";

/**
 * Map the SDK's `write_todos` tool input (`{ todos: [{ task, completed }] }`)
 * to an ACP plan. The first unfinished item is reported as in progress so
 * hosts can highlight the active step.
 */
export function todosToPlan(input: unknown): Plan | null {
  if (typeof input !== "object" || input === null) return null;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;

  let activeAssigned = false;
  const entries: PlanEntry[] = [];
  for (const todo of todos) {
    if (typeof todo !== "object" || todo === null) continue;
    const { task, completed } = todo as { task?: unknown; completed?: unknown };
    if (typeof task !== "string" || task.trim() === "") continue;
    let status: PlanEntry["status"] = "pending";
    if (completed === true) {
      status = "completed";
    } else if (!activeAssigned) {
      status = "in_progress";
      activeAssigned = true;
    }
    entries.push({ content: task, priority: "medium", status });
  }
  return { entries };
}
