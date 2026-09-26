import type { AgentTimelineItem, AgentUsage, ToolCallDetail } from "@getpaseo/protocol/agent-types";
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

export interface Recorder {
  turnStarted(input: TurnStartedInput): void;
  timelineItem(input: TimelineItemInput): void;
  turnEnded(input: TurnEndedInput): void;
  /** Stash usage on the open turn; turn/end reports it if no terminal usage arrives. */
  usage(input: UsageInput): void;
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
  const candidates: Array<string | undefined> = [];
  if ("output" in detail) candidates.push(detail.output);
  if ("content" in detail) candidates.push(detail.content);
  if ("result" in detail) candidates.push(detail.result);
  if ("log" in detail) candidates.push(detail.log);
  for (const text of candidates) {
    if (typeof text === "string") return text.length;
  }
  return null;
}

export function createRecorder(options: { store: TrajectoryStore; now?: () => Date }): Recorder {
  const { store, now = () => new Date() } = options;

  /** agentId -> its open turns, newest last. */
  const openTurns = new Map<string, OpenTurn[]>();
  /** Dedupe: `${agentId}\u0000${callId}\u0000${phase}`. */
  const seenToolPhases = new Set<string>();
  /** Terminated turn keys `${agentId}\u0000${turnId}` — hook+stream double terminals dedupe here. */
  const terminatedTurns = new Set<string>();

  const append = (input: Omit<TrajectoryEventInput, "time">): void => {
    store.append({ ...input, time: nowIso(now) });
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

  const toolPhaseSeen = (agentId: string, callId: string, phase: "call" | "result"): boolean => {
    const key = `${agentId}\u0000${callId}\u0000${phase}`;
    if (seenToolPhases.has(key)) return true;
    seenToolPhases.add(key);
    return false;
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
          data: { textLength: typeof item.text === "string" ? item.text.length : null },
        });
        return;
      }

      if (item.type === "tool_call") {
        recordToolCall(input, item);
      }
    },

    turnEnded(input) {
      const open = takeOpenTurn(input.agentId, input.turnId);

      // Exactly one terminal per turn: a second terminal for an already
      // terminated id is a no-op. Turns we never saw opened still record
      // (lazy attach), and null-turnId terminals always record.
      if (!open && input.turnId && !markTurnTerminated(input.agentId, input.turnId)) return;
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
  };
}
