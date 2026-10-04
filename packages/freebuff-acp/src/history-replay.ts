/**
 * Rebuilds ACP `session/update` notifications from a persisted RunState so
 * `session/load` can replay a past conversation into the host timeline.
 *
 * Paseo keeps its timeline in memory only: after a daemon restart it refills
 * the timeline by calling `session/load` and consuming the replayed updates.
 * Without replay the model keeps its context but the user sees an empty chat.
 */

export type ReplayUpdate = Record<string, unknown> & { sessionUpdate: string };

/** Tool output is capped in the replay; the model's copy in RunState is untouched. */
const MAX_REPLAYED_TOOL_OUTPUT_CHARS = 4000;

interface HistoryMessage {
  role?: unknown;
  tags?: unknown;
  toolCallId?: unknown;
  content?: unknown;
}

function messageParts(message: HistoryMessage): Record<string, unknown>[] {
  return Array.isArray(message.content)
    ? message.content.filter(
        (part): part is Record<string, unknown> => typeof part === "object" && part !== null,
      )
    : [];
}

function truncate(text: string): string {
  return text.length > MAX_REPLAYED_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_REPLAYED_TOOL_OUTPUT_CHARS)}… [truncated]`
    : text;
}

function textUpdate(sessionUpdate: string, text: string): ReplayUpdate {
  return { sessionUpdate, content: { type: "text", text } };
}

/** Only messages the user actually typed carry the USER_PROMPT tag; the rest is injected context. */
function isUserPrompt(message: HistoryMessage): boolean {
  return Array.isArray(message.tags) && message.tags.includes("USER_PROMPT");
}

function userUpdates(message: HistoryMessage): ReplayUpdate[] {
  if (!isUserPrompt(message)) return [];
  return messageParts(message).flatMap((part) =>
    part.type === "text" && typeof part.text === "string"
      ? [textUpdate("user_message_chunk", part.text)]
      : [],
  );
}

function assistantPartUpdate(part: Record<string, unknown>): ReplayUpdate[] {
  if (typeof part.text === "string") {
    if (part.type === "text") return [textUpdate("agent_message_chunk", part.text)];
    if (part.type === "reasoning") return [textUpdate("agent_thought_chunk", part.text)];
  }
  if (part.type === "tool-call" && typeof part.toolCallId === "string") {
    return [
      {
        sessionUpdate: "tool_call",
        toolCallId: part.toolCallId,
        title: typeof part.toolName === "string" ? part.toolName : "tool",
        kind: "other",
        status: "in_progress",
        rawInput: part.input,
      },
    ];
  }
  return [];
}

function toolResultUpdates(message: HistoryMessage): ReplayUpdate[] {
  if (typeof message.toolCallId !== "string") return [];
  const output = JSON.stringify(messageParts(message).map((part) => part.value ?? part));
  return [
    {
      sessionUpdate: "tool_call_update",
      toolCallId: message.toolCallId,
      status: "completed",
      rawOutput: truncate(output),
    },
  ];
}

function messageUpdates(message: HistoryMessage): ReplayUpdate[] {
  if (message.role === "user") return userUpdates(message);
  if (message.role === "assistant") return messageParts(message).flatMap(assistantPartUpdate);
  if (message.role === "tool") return toolResultUpdates(message);
  return [];
}

export function runStateToReplayUpdates(runState: Record<string, unknown> | null): ReplayUpdate[] {
  const mainAgentState = runState?.mainAgentState as { messageHistory?: unknown } | undefined;
  const history = mainAgentState?.messageHistory;
  if (!Array.isArray(history)) return [];
  return (history as HistoryMessage[]).flatMap(messageUpdates);
}
