import type { AgentTimelineItem, AgentUsage, ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { TrajectoryEvent } from "../shared/trajectory.js";
import type { TrajectoryEventInput, TrajectoryStore } from "./store.js";

/**
 * Pure recorder: maps paseo agent events onto the trajectory ledger.
 *
 * No daemon wiring here — the plugin entry owns registration. Fixes the
 * paseo-fleet reference bugs by construction:
 * - tool events attribute to the explicit turnId, else the agent's currently
 *   open turn; with no open turn they get turn=null (never a phantom
 *   "synthetic" turn — reference bug 3);
 * - per-agent open-turn maps, so an ended turn never blocks a later one and
 *   every turn gets its own terminal (reference bug 4);
 * - call/result dedupe on agentId+callId+phase, so hook fallback + stream
 *   replay cannot double-write (reference bug 5);
 * - unknown values are null, never guessed.
 */

export interface TurnStartedInput {
  agentId: string;
  turnId: string | null;
  provider?: string | null;
  model?: string | null;
}

export type TurnOutcome = "completed" | "failed" | "canceled";

export interface TurnEndedInput {
  agentId: string;
  turnId: string | null;
  outcome: TurnOutcome;
  usage?: AgentUsage | null;
  error?: string | null;
}

export interface TimelineItemInput {
  agentId: string;
  turnId?: string | null;
  item: AgentTimelineItem;
}

export interface UsageInput {
  agentId: string;
  turnId?: string | null;
  usage: AgentUsage;
}

/** Fires after each row is stored (with its assigned seq). The push seam: a
 *  future server-push transport fans out from here; today nobody subscribes. */
export type LedgerAppendListener = (event: TrajectoryEvent) => void;

export interface Recorder {
  turnStarted(input: TurnStartedInput): void;
  timelineItem(input: TimelineItemInput): void;
  turnEnded(input: TurnEndedInput): void;
  /** Stash usage on the open turn; turn/end reports it if no terminal usage arrives. */
  usage(input: UsageInput): void;
  /**
   * Record the caller system prompt's SIZE and a short hash. Never the text:
   * the ledger is length-only by rule, and d-893c722f28 sets the hash precedent
   * for something that must be comparable across runs without being readable.
   */
  systemPromptAttached(input: SystemPromptInput): void;
}

export interface SystemPromptInput {
  agentId: string;
  /** Character count of the caller-supplied prompt. */
  charsLength: number;
  /** First 12 hex chars of the prompt's sha256, for equality comparison. */
  hash12: string;
  /**
   * How the row was attributed to this agent: "config" when the create config
   * matched the agent exactly, "fifo" when it fell back to the oldest pending
   * create. The daemon exposes no request id on either hook, so this is recorded
   * rather than assumed.
   */
  correlated?: "config" | "fifo";
}

interface OpenTurn {
  turnId: string | null;
  model: string | null;
  /** 1-based step counter within the turn. */
  step: number;
  /** true while step/start has been emitted for the current step. */
  stepOpen: boolean;
  /** Open tool callIds -> started wall time (ms). */
  openTools: Map<string, number>;
  /** Usage seen mid-turn (usage_updated); reported at terminal if not superseded. */
  usage: AgentUsage | null;
  /**
   * Tool results recorded since the last round marker. Zero means no LLM round
   * boundary is pending, which is the whole trigger condition below.
   */
  resultsSinceRound: number;
  /** 1-based count of round markers emitted in this turn. */
  rounds: number;
}

const ARG_SUMMARY_MAX = 200;
/** Bound for the terminated-turn dedupe set (approximate turns, memory guard). */
const MAX_TERMINATED_TURNS = 1000;

function nowIso(now: () => Date): string {
  return now().toISOString();
}

/** Short, bounded, secret-free summary of what a tool call was asked to do. */
function argSummary(detail: ToolCallDetail | undefined): string | null {
  if (!detail) return null;
  let raw: string | null = null;
  switch (detail.type) {
    case "shell":
      raw = detail.command;
      break;
    case "read":
      raw = detail.filePath;
      break;
    case "edit":
      raw = detail.filePath;
      break;
    case "write":
      raw = detail.filePath;
      break;
    case "search":
      raw = detail.query ?? detail.toolName ?? null;
      break;
    case "fetch":
      raw = detail.url;
      break;
    case "sub_agent":
      raw = detail.description ?? detail.subAgentType ?? null;
      break;
    default:
      raw = null;
  }
  if (typeof raw !== "string" || raw.length === 0) return null;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > ARG_SUMMARY_MAX ? oneLine.slice(0, ARG_SUMMARY_MAX - 1) + "…" : oneLine;
}

/** Character count of the tool output as delivered to the agent, if present. */
function toolOutputChars(detail: ToolCallDetail | undefined): number | null {
  if (!detail) return null;
  // `in` narrows the KEY but not the VALUE across this union — one variant types
  // `output` as unknown — so each candidate is read defensively.
  const candidates: Array<unknown> = [];
  if ("output" in detail) candidates.push(detail.output);
  if ("content" in detail) candidates.push(detail.content);
  if ("result" in detail) candidates.push(detail.result);
  if ("log" in detail) candidates.push(detail.log);
  for (const text of candidates) {
    if (typeof text === "string") return text.length;
  }
  return null;
}

export function createRecorder(options: {
  store: TrajectoryStore;
  now?: () => Date;
  onAppend?: LedgerAppendListener;
}): Recorder {
  const { store, now = () => new Date(), onAppend } = options;

  /** agentId -> its open turns, newest last. */
  const openTurns = new Map<string, OpenTurn[]>();
  /** Dedupe: `${agentId}\u0000${callId}\u0000${phase}`. */
  const seenToolPhases = new Set<string>();
  /** Terminated turn keys `${agentId}\u0000${turnId}` — hook+stream double terminals dedupe here. */
  const terminatedTurns = new Set<string>();

  const append = (input: Omit<TrajectoryEventInput, "time">): void => {
    const stored = store.append({ ...input, time: nowIso(now) });
    onAppend?.(stored);
  };

  /** De-dupes double terminals; bounded FIFO. Returns false when already seen. */
  const markTurnTerminated = (agentId: string, turnId: string): boolean => {
    const key = `${agentId}\u0000${turnId}`;
    if (terminatedTurns.has(key)) return false;
    terminatedTurns.add(key);
    if (terminatedTurns.size > MAX_TERMINATED_TURNS) {
      const oldest = terminatedTurns.values().next().value;
      if (oldest !== undefined) terminatedTurns.delete(oldest);
    }
    return true;
  };

  /** Pop the matching open turn; null when the recorder never saw it open. */
  const takeOpenTurn = (agentId: string, turnId: string | null): OpenTurn | undefined => {
    const turns = openTurns.get(agentId);
    if (!turns || turns.length === 0) return undefined;
    const index = turnId ? turns.findIndex((turn) => turn.turnId === turnId) : -1;
    if (index < 0) return undefined;
    const [open] = turns.splice(index, 1);
    if (turns.length === 0) openTurns.delete(agentId);
    return open;
  };

  const openTurnOf = (agentId: string, turnId?: string | null): OpenTurn | null => {
    const turns = openTurns.get(agentId);
    if (!turns || turns.length === 0) return null;
    if (turnId) {
      const found = turns.find((turn) => turn.turnId === turnId);
      if (found) return found;
    }
    return turns[turns.length - 1];
  };

  /**
   * Dedupe a tool phase across restarts, not just within one process.
   *
   * The in-memory set cannot see rows written by an earlier run, and the
   * turn_ended replay re-sends an agent's whole timeline — so a replay after a
   * re-attach would duplicate every call. The store is consulted first; the set
   * still does the fast path when the store has no such query.
   */
  const toolPhaseSeen = (agentId: string, callId: string, phase: "call" | "result"): boolean => {
    const key = `${agentId}\u0000${callId}\u0000${phase}`;
    if (seenToolPhases.has(key)) return true;
    if (store.hasToolPhase?.(agentId, callId, phase) === true) {
      seenToolPhases.add(key);
      return true;
    }
    seenToolPhases.add(key);
    return false;
  };

  /**
   * Emit an LLM-round boundary if one is pending on this turn.
   *
   * No provider hands plugins a real "the model was called" event, so the round
   * is derived from the one thing every provider does emit: an action arriving
   * AFTER tool results. If results are waiting and the next thing the agent does
   * is start a tool or emit a message, those results must have been handed to a
   * model first -- that is the round. The claim is falsifiable and provider
   * agnostic, and it is only made when results are actually outstanding, so a
   * turn with no tool work never gets a marker.
   */
  const maybeMarkRound = (open: OpenTurn | null, turnId: string | null, agentId: string): void => {
    if (open === null || open.resultsSinceRound === 0) return;
    open.rounds += 1;
    append({
      type: "round/begin",
      turn: turnId,
      step: null,
      agentId,
      data: {
        derived: true,
        ordinal: open.rounds,
        consumedResults: open.resultsSinceRound,
      },
    });
    open.resultsSinceRound = 0;
  };

  const resolveTurnForTool = (agentId: string, turnId?: string | null): string | null => {
    if (turnId) return turnId;
    const open = openTurnOf(agentId);
    return open?.turnId ?? null;
  };

  const recordToolCall = (
    input: TimelineItemInput,
    item: Extract<AgentTimelineItem, { type: "tool_call" }>,
  ): void => {
    const { agentId } = input;
    const callId = item.callId;
    const turnId = resolveTurnForTool(agentId, input.turnId);
    const open = openTurnOf(agentId, input.turnId);

    if (item.status === "running") {
      if (toolPhaseSeen(agentId, callId, "call")) return;
      maybeMarkRound(open, turnId, agentId);
      if (open) open.openTools.set(callId, now().getTime());
      append({
        type: "tool/call",
        turn: turnId,
        step: null,
        agentId,
        data: {
          callId,
          name: item.name,
          argSummary: argSummary(item.detail),
        },
      });
      return;
    }

    // Terminal tool item (completed | failed | canceled).
    if (toolPhaseSeen(agentId, callId, "result")) return;
    // Orphan terminal: the call row never arrived (a resumed agent replays its
    // history as results only, and a mid-flight attach can miss the start). Write
    // the paired call FIRST, backfilled from the terminal item's own fields, so
    // every result in the ledger has a call and the fold never has to invent one.
    // `backfilled` marks it as reconstructed rather than observed.
    if (!toolPhaseSeen(agentId, callId, "call")) {
      append({
        type: "tool/call",
        turn: turnId,
        step: null,
        agentId,
        data: {
          callId,
          name: item.name,
          argSummary: argSummary(item.detail),
          backfilled: true,
        },
      });
    }
    const startedAt = open?.openTools.get(callId);
    open?.openTools.delete(callId);
    const durationMs = startedAt === undefined ? null : now().getTime() - startedAt;
    append({
      type: "tool/result",
      turn: turnId,
      step: null,
      agentId,
      data: {
        callId,
        name: item.name,
        outputChars: toolOutputChars(item.detail),
        isError: item.status === "failed",
        durationMs,
      },
    });
    // A completed result is what a model has to consume before its next action.
    if (open) open.resultsSinceRound += 1;
  };

  return {
    turnStarted(input) {
      // Hook and stream paths both fire turn_started for the same live turn;
      // a turn already open with this id is a duplicate, not a new turn.
      const existing = openTurns.get(input.agentId);
      if (input.turnId && existing?.some((turn) => turn.turnId === input.turnId)) return;
      const turn: OpenTurn = {
        turnId: input.turnId,
        model: input.model ?? null,
        step: 0,
        stepOpen: false,
        openTools: new Map(),
        usage: null,
        resultsSinceRound: 0,
        rounds: 0,
      };
      const turns = existing ?? [];
      turns.push(turn);
      openTurns.set(input.agentId, turns);
      // The id may repeat after a session reopens; it is live again now.
      if (input.turnId) terminatedTurns.delete(`${input.agentId}\u0000${input.turnId}`);
      append({
        type: "turn/start",
        turn: input.turnId,
        step: null,
        agentId: input.agentId,
        data: {
          provider: input.provider ?? null,
          model: input.model ?? null,
        },
      });
    },

    timelineItem(input) {
      const { agentId, item } = input;

      if (item.type === "assistant_message") {
        // One step per assistant message segment (dsh vocabulary).
        const open = openTurnOf(agentId, input.turnId);
        const turnId = open?.turnId ?? input.turnId ?? null;
        const step = open ? ++open.step : null;
        if (open) open.stepOpen = true;
        maybeMarkRound(open, turnId, agentId);
        append({
          type: "step/start",
          turn: turnId,
          step,
          agentId,
          data: {},
        });
        const usage: Record<string, number | null> = {
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          reasoningTokens: null,
        };
        append({
          type: "assistant/message",
          turn: turnId,
          step,
          agentId,
          data: {
            model: open?.model ?? null,
            usage,
            // Length only — never the prompt or secret text itself.
            textLength: typeof item.text === "string" ? item.text.length : null,
            // The source timeline item's identity, so the client can fetch this
            // one record's text on demand. A foreign key, not content, so the
            // length-only rule above is untouched. The SDK's timeline.item event
            // carries no seq, so messageId is the only stable key available.
            sourceMessageId: item.messageId ?? null,
          },
        });
        append({
          type: "step/end",
          turn: turnId,
          step,
          agentId,
          data: {},
        });
        if (open) open.stepOpen = false;
        return;
      }

      if (item.type === "user_message") {
        append({
          type: "user/message",
          turn: resolveTurnForTool(agentId, input.turnId),
          step: null,
          agentId,
          data: {
            textLength: typeof item.text === "string" ? item.text.length : null,
            // Foreign key, not content — see the assistant/message note.
            sourceMessageId: item.messageId ?? item.clientMessageId ?? null,
          },
        });
        return;
      }

      if (item.type === "tool_call") {
        recordToolCall(input, item);
      }
    },

    turnEnded(input) {
      // Exactly one terminal per turn, on BOTH the hook and the stream path.
      // The guard used to run only when the recorder had no open turn, so the
      // FIRST terminal (which does have one) never marked the turn terminated
      // and a second terminal sailed through and wrote a duplicate turn/end --
      // PROD carried 78 terminals against 44 starts. Marking first fixes it:
      // the first caller wins, every later one is a no-op. Turns we never saw
      // opened still record (lazy attach), and null-turnId terminals always
      // record because there is no id to dedupe on.
      if (input.turnId && !markTurnTerminated(input.agentId, input.turnId)) return;
      const open = takeOpenTurn(input.agentId, input.turnId);
      // Any tools still marked open at terminal time have no reported end.
      open?.openTools.clear();

      const usage = input.usage ?? open?.usage ?? undefined;
      append({
        type: "turn/end",
        turn: input.turnId,
        step: null,
        agentId: input.agentId,
        data: {
          outcome: input.outcome,
          error: input.error ?? null,
          model: open?.model ?? null,
          // Always the same shape; every field is null when unreported.
          usage: {
            inputTokens: usage?.inputTokens ?? null,
            outputTokens: usage?.outputTokens ?? null,
            cachedInputTokens: usage?.cachedInputTokens ?? null,
            reasoningTokens: null,
          },
        },
      });
    },

    usage(input) {
      const open = openTurnOf(input.agentId, input.turnId);
      if (!open) return; // Usage without turn context cannot be attributed.
      open.usage = input.usage;
    },

    systemPromptAttached(input) {
      // turn=null on purpose: the prompt is bound to the agent, not to a turn,
      // and it was in force before any turn existed.
      append({
        type: "system/attach",
        turn: null,
        step: null,
        agentId: input.agentId,
        data: {
          derived: true,
          charsLength: input.charsLength,
          hash12: input.hash12,
          ...(input.correlated === undefined ? {} : { correlated: input.correlated }),
        },
      });
    },
  };
}
