/**
 * Conversation state is an opaque SDK `RunState`. A turn that fails or is
 * cancelled can hand back nothing, or a fresh state with an empty history;
 * adopting that verbatim silently wipes the session (the next prompt then
 * answers as if the conversation never happened, also after a resume).
 */

type SessionState = Record<string, unknown>;

function messageCount(state: SessionState | null): number {
  const main = state?.mainAgentState as { messageHistory?: unknown } | undefined;
  return Array.isArray(main?.messageHistory) ? main.messageHistory.length : 0;
}

/**
 * Pick the state to keep after a turn. A successful turn always advances the
 * conversation. Any other outcome only advances it when the new state still
 * holds at least as many messages as before (partial progress); otherwise
 * the previous conversation is kept.
 */
export function nextConversationState(
  previous: SessionState | null,
  next: SessionState | null,
  stopReason: string,
): SessionState | null {
  if (!next) return previous;
  if (stopReason === "end_turn") return next;
  return messageCount(next) >= messageCount(previous) ? next : previous;
}

/**
 * The SDK continues a conversation from `previousRun.sessionState`. The adapter
 * keeps (and persists) the session state itself, so wrap it; a state already
 * in RunState shape (older persisted files) is passed through unchanged.
 * Passing the bare session state makes the SDK silently start a fresh
 * conversation every turn.
 */
export function toPreviousRun(state: SessionState): Record<string, unknown> {
  if ("sessionState" in state) return state;
  return { sessionState: state, output: { type: "lastMessage", value: [] } };
}
