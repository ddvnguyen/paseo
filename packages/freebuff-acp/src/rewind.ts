/**
 * Conversation rewind for freebuff-acp (owner directive 2026-09-26: Freebuff
 * ACP must support chat rollback like other Paseo providers).
 *
 * Model: per-user-turn checkpoints of the FULL conversation state as it was
 * BEFORE that prompt ran. Rewinding to user turn N (1-based ordinal, computed
 * by the host bridge from its own timeline — stable across restarts, no
 * cross-layer id sharing needed) restores checkpoint N and drops N..last.
 *
 * Two checkpoint sources:
 *  - Recorded: the adapter snapshots the pre-turn state on every accepted
 *    prompt (bounded ring). Exact state, including SDK counters.
 *  - Reconstructed: sessions that predate checkpoints (or turns beyond the
 *    ring) are rebuilt from the persisted RunState by truncating
 *    messageHistory at the target USER_PROMPT. Approximate (latest SDK
 *    counters are kept) but correct for conversation content — the same
 *    contract codex rewind fulfills with thread rollback.
 *
 * Reconstruction is only ever applied to a COPY handed to the SDK as
 * previousRun; the live session state is replaced atomically by the caller.
 */

/** Bounded checkpoint ring: enough depth for practical rewinds, capped size. */
export const MAX_CHECKPOINTS = 20;

export interface RunStateCheckpoint {
  /** 1-based ordinal of the user turn this checkpoint PRECEDES. */
  turn: number;
  /** The pre-turn conversation state (`null` = the session had not started). */
  runState: Record<string, unknown> | null;
  /** Human text of the dropped prompt (host display / debugging). */
  promptText: string;
  createdAt: string;
}

interface HistoryMessage {
  role?: unknown;
  tags?: unknown;
  content?: unknown;
}

function isUserPrompt(message: HistoryMessage): boolean {
  return Array.isArray(message.tags) && message.tags.includes("USER_PROMPT");
}

function historyOf(runState: Record<string, unknown> | null): HistoryMessage[] {
  const main = runState?.mainAgentState as { messageHistory?: unknown } | undefined;
  return Array.isArray(main?.messageHistory) ? (main.messageHistory as HistoryMessage[]) : [];
}

/** First message index of user turn `turn` (1-based) in `history`. */
function userTurnStartIndex(history: HistoryMessage[], turn: number): number {
  let seen = 0;
  for (let index = 0; index < history.length; index += 1) {
    if (isUserPrompt(history[index])) {
      seen += 1;
      if (seen === turn) return index;
    }
  }
  return -1;
}

function promptTextOf(message: HistoryMessage): string {
  const parts = Array.isArray(message.content) ? message.content : [];
  return parts
    .map((part) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * Synthesize the pre-turn state for user turn `turn` from `runState` by
 * truncating messageHistory at the turn's first message. Returns null when
 * the turn does not exist (or has no USER_PROMPT marker — injected-only
 * history cannot be rewound safely).
 */
export function reconstructCheckpoint(
  runState: Record<string, unknown> | null,
  turn: number,
): RunStateCheckpoint | null {
  if (!runState || turn < 1) return null;
  const history = historyOf(runState);
  const start = userTurnStartIndex(history, turn);
  if (start === -1) return null;
  const main = runState.mainAgentState as Record<string, unknown> | undefined;
  return {
    turn,
    runState: {
      ...runState,
      ...(main ? { mainAgentState: { ...main, messageHistory: history.slice(0, start) } } : {}),
    },
    promptText: promptTextOf(history[start]),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Total user turns in a conversation state (for validation / host display).
 */
export function countUserTurns(runState: Record<string, unknown> | null): number {
  return historyOf(runState).filter(isUserPrompt).length;
}

/**
 * The checkpoint to restore when rewinding to user turn `turn` (1-based):
 * prefer the recorded ring entry; fall back to reconstruction from the
 * CURRENT persisted state. Returns null when the turn is unknown (the host
 * surfaces an error, mirroring codex rewind).
 */
export function checkpointForRewind(
  checkpoints: RunStateCheckpoint[] | undefined,
  runState: Record<string, unknown> | null,
  turn: number,
): RunStateCheckpoint | null {
  if (!Number.isInteger(turn) || turn < 1) return null;
  const recorded = (checkpoints ?? []).find((c) => c.turn === turn);
  if (recorded) return recorded;
  return reconstructCheckpoint(runState, turn);
}

/** Checkpoints surviving a rewind to `turn`: everything before it. */
export function checkpointsAfterRewind(
  checkpoints: RunStateCheckpoint[] | undefined,
  turn: number,
): RunStateCheckpoint[] {
  return (checkpoints ?? []).filter((c) => c.turn < turn);
}

/**
 * Record the pre-turn state for the prompt that is about to run. `turn` is
 * the prompt's 1-based user-turn ordinal (the session's next user turn).
 */
export function recordCheckpoint(options: {
  checkpoints: RunStateCheckpoint[] | undefined;
  turn: number;
  promptText: string;
  runState: Record<string, unknown> | null;
}): RunStateCheckpoint[] {
  const next = (options.checkpoints ?? []).filter((c) => c.turn !== options.turn);
  next.push({
    turn: options.turn,
    runState: options.runState,
    promptText: options.promptText,
    createdAt: new Date().toISOString(),
  });
  next.sort((a, b) => a.turn - b.turn);
  return next.slice(-MAX_CHECKPOINTS);
}
