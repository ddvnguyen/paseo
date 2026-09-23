import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { PrintModeEvent } from "@codebuff/sdk";

/**
 * Map Codebuff tool names to ACP tool kinds so hosts can pick icons and
 * treatment. Unknown tools default to "other".
 */
const TOOL_KIND_BY_NAME: Record<string, ToolKind> = {
  read_files: "read",
  read_subtree: "read",
  read_docs: "read",
  code_search: "search",
  find_files: "search",
  glob: "search",
  list_directory: "search",
  run_terminal_command: "execute",
  str_replace: "edit",
  propose_str_replace: "edit",
  write_file: "edit",
  propose_write_file: "edit",
  apply_patch: "edit",
  browser_logs: "fetch",
  web_search: "fetch",
  read_url: "fetch",
  think_deeply: "think",
  add_subgoal: "think",
  update_subgoal: "think",
  skill: "think",
};

export function toolKindFor(toolName: string): ToolKind {
  return TOOL_KIND_BY_NAME[toolName] ?? "other";
}

function humanizeToolName(toolName: string): string {
  return toolName
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Compact JSON-ish preview of a tool input for tool call titles. */
function summarizeInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  const parts: string[] = [];
  for (const key of keys.slice(0, 3)) {
    const value = input[key];
    if (typeof value === "string") {
      parts.push(`${key}: ${truncate(value.replace(/\s+/g, " ").trim(), 60)}`);
    } else if (value !== undefined && value !== null && typeof value !== "object") {
      parts.push(`${key}: ${String(value)}`);
    } else {
      parts.push(`${key}: …`);
    }
  }
  const suffix = keys.length > 3 ? `, +${keys.length - 3} more` : "";
  return ` (${parts.join(", ")}${suffix})`;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

interface ToolCallEventLike {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ToolResultEventLike {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  output: Array<
    { type: "json"; value: unknown } | { type: "media"; data: string; mediaType: string }
  >;
}

/** Build the initial ACP tool_call session update from a Codebuff tool_call event. */
export function mapToolCallEvent(event: ToolCallEventLike): SessionUpdate {
  const toolCall: ToolCallUpdate = {
    toolCallId: event.toolCallId,
    title: `${humanizeToolName(event.toolName)}${summarizeInput(event.input)}`,
    kind: toolKindFor(event.toolName),
    status: "in_progress",
  };
  return { sessionUpdate: "tool_call", ...toolCall } as SessionUpdate;
}

/** Build the terminal ACP tool_call_update session update from a Codebuff tool_result event. */
export function mapToolResultEvent(event: ToolResultEventLike): SessionUpdate {
  const failed = event.output.some(
    (item) =>
      item.type === "json" &&
      typeof item.value === "object" &&
      item.value !== null &&
      "error" in (item.value as Record<string, unknown>),
  );
  const content: ToolCallContent[] = [];
  for (const item of event.output) {
    if (item.type === "json") {
      const text = safeJsonText(item.value);
      if (text) {
        content.push({ type: "content", content: { type: "text", text } satisfies ContentBlock });
      }
    }
    // Media outputs (images) are dropped: the adapter does not advertise image support.
  }
  const update: ToolCallUpdate = {
    toolCallId: event.toolCallId,
    status: (failed ? "failed" : "completed") satisfies ToolCallStatus,
    ...(content.length > 0 ? { content } : {}),
  };
  return { sessionUpdate: "tool_call_update", ...update } as SessionUpdate;
}

function safeJsonText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? null : truncate(rendered, 2000);
  } catch {
    return null;
  }
}

export type { PrintModeEvent };
