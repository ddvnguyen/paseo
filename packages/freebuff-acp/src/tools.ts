import path from "node:path";

import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
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

function absolutePath(candidate: string, cwd: string | undefined): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(cwd ?? process.cwd(), candidate);
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Files a tool touches, so hosts can render path chips / open the file. */
function locationsFor(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
): ToolCallLocation[] {
  if (toolName === "read_files" && Array.isArray(input.paths)) {
    return input.paths
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => ({ path: absolutePath(entry, cwd) }));
  }
  const single = stringField(input, "path");
  return single ? [{ path: absolutePath(single, cwd) }] : [];
}

/** Diff content for edit tools so hosts render a real diff instead of raw JSON. */
function diffContentFor(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
): ToolCallContent[] {
  const target = stringField(input, "path");
  if (!target) return [];
  const filePath = absolutePath(target, cwd);
  if (toolName === "write_file" && typeof input.content === "string") {
    return [{ type: "diff", path: filePath, oldText: null, newText: input.content }];
  }
  if (toolName === "str_replace" && Array.isArray(input.replacements)) {
    const diffs: ToolCallContent[] = [];
    for (const replacement of input.replacements) {
      if (typeof replacement !== "object" || replacement === null) continue;
      const { old, new: next } = replacement as { old?: unknown; new?: unknown };
      if (typeof old === "string" && typeof next === "string") {
        diffs.push({ type: "diff", path: filePath, oldText: old, newText: next });
      }
    }
    return diffs;
  }
  return [];
}

/**
 * Build the initial ACP tool_call session update from a Codebuff tool_call
 * event. `cwd` resolves relative tool paths into absolute locations.
 */
export function mapToolCallEvent(event: ToolCallEventLike, cwd?: string): SessionUpdate {
  const locations = locationsFor(event.toolName, event.input, cwd);
  const content = diffContentFor(event.toolName, event.input, cwd);
  const toolCall: ToolCallUpdate = {
    toolCallId: event.toolCallId,
    title: `${humanizeToolName(event.toolName)}${summarizeInput(event.input)}`,
    kind: toolKindFor(event.toolName),
    status: "in_progress",
    rawInput: event.input,
    ...(locations.length > 0 ? { locations } : {}),
    ...(content.length > 0 ? { content } : {}),
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
    if (item.type === "media" && item.mediaType.startsWith("image/")) {
      content.push({
        type: "content",
        content: { type: "image", data: item.data, mimeType: item.mediaType } satisfies ContentBlock,
      });
    }
  }
  const update: ToolCallUpdate = {
    toolCallId: event.toolCallId,
    status: (failed ? "failed" : "completed") satisfies ToolCallStatus,
    rawOutput: rawOutputFor(event.output),
    ...(content.length > 0 ? { content } : {}),
  };
  return { sessionUpdate: "tool_call_update", ...update } as SessionUpdate;
}

/** Structured result for hosts: the lone JSON value, else the list of JSON values. */
function rawOutputFor(output: ToolResultEventLike["output"]): unknown {
  const values = output.flatMap((item) => (item.type === "json" ? [item.value] : []));
  return values.length === 1 ? values[0] : values;
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
