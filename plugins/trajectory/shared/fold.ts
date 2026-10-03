import type {
  TrajectoryCell,
  TrajectoryEvent,
  TrajectorySnapshot,
  TrajectoryStep,
  TrajectoryTurn,
  TrajectoryUsage,
} from "./trajectory.js";

/**
 * Pure fold: ledger rows -> TrajectorySnapshot. No I/O, no clocks, no
 * mutation of inputs. Unknown values stay null (render "—"); in-flight rows
 * have no duration. Mirrors the dsh fold: one Tool row per call+result pair
 * (own duration = result.time - call.time), usage hangs on Message rows only,
 * user rows fold into the turn they arrived in.
 */

const LABEL_MAX = 120;

interface TurnAcc {
  turnId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  outcome: TrajectoryTurn["outcome"];
  error: string | null;
  usage: TrajectoryUsage | null;
  steps: Map<number | null, TrajectoryStep>;
  stepOrder: Array<number | null>;
  users: TrajectoryCell[];
}

interface FoldState {
  turns: Map<string | null, TurnAcc>;
  /** Open tool calls: `${turnId}\u0000${callId}` -> call event. */
  openTools: Map<string, TrajectoryEvent>;
  /** Rows that arrived with turn=null and no open turn. */
  orphans: TrajectoryCell[];
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > LABEL_MAX ? oneLine.slice(0, LABEL_MAX - 1) + "…" : oneLine;
}

function usageOf(raw: unknown): TrajectoryUsage {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    input: typeof source.inputTokens === "number" ? source.inputTokens : null,
    cacheRead: typeof source.cachedInputTokens === "number" ? source.cachedInputTokens : null,
    cacheWrite: typeof source.cacheWriteTokens === "number" ? source.cacheWriteTokens : null,
    output: typeof source.outputTokens === "number" ? source.outputTokens : null,
    think: typeof source.reasoningTokens === "number" ? source.reasoningTokens : null,
  };
}

function timeMs(event: TrajectoryEvent): number | null {
  const parsed = Date.parse(event.time);
  return Number.isFinite(parsed) ? parsed : null;
}

function durationBetween(startMs: number | null, endMs: number | null): number | null {
  if (startMs === null || endMs === null) return null;
  return Math.max(0, endMs - startMs);
}

function newStep(step: number | null): TrajectoryStep {
  return { step, message: null, tools: [] };
}

function newTurn(turnId: string): TurnAcc {
  return {
    turnId,
    startedAt: null,
    endedAt: null,
    outcome: "in-flight",
    error: null,
    usage: null,
    steps: new Map(),
    stepOrder: [],
    users: [],
  };
}

function toolLabel(name: string, args: string | null): string {
  return args ? `${name} · ${args}` : name;
}

function toolCellFromCall(event: TrajectoryEvent): TrajectoryCell {
  const name = typeof event.data.name === "string" && event.data.name ? event.data.name : "tool";
  const args = typeof event.data.argSummary === "string" ? truncate(event.data.argSummary) : null;
  return {
    kind: "tool",
    label: toolLabel(name, args),
    durationMs: null, // paired at tool/result
    usage: null,
    outputChars: null,
    isError: null,
    seq: event.seq,
    seqs: [event.seq],
  };
}

function userCell(event: TrajectoryEvent): TrajectoryCell {
  const label =
    typeof event.data.textLength === "number"
      ? `user message (${event.data.textLength} chars)`
      : "user message";
  return {
    kind: "user",
    label,
    durationMs: null,
    usage: null,
    outputChars: null,
    isError: null,
    seq: event.seq,
    seqs: [event.seq],
  };
}

function messageCell(event: TrajectoryEvent): TrajectoryCell {
  const label =
    typeof event.data.textLength === "number"
      ? `assistant message (${event.data.textLength} chars)`
      : "assistant message";
  return {
    kind: "message",
    label,
    durationMs: null,
    usage: usageOf(event.data.usage),
    outputChars: null,
    isError: null,
    seq: event.seq,
    seqs: [event.seq],
  };
}

function foldTurnStart(state: FoldState, event: TrajectoryEvent): void {
  const turn = turnFor(state, event);
  if (!turn) return;
  if (turn.startedAt === null) turn.startedAt = event.time;
}

function foldUserMessage(state: FoldState, event: TrajectoryEvent): void {
  const cell = userCell(event);
  if (event.turn !== null) {
    // Create the bucket on demand: a user row may precede turn/start.
    turnFor(state, event)?.users.push(cell);
    return;
  }
  // turn=null user rows: attach to the open in-flight turn, else orphans.
  const openTurn = [...state.turns.values()].find((turn) => turn.endedAt === null);
  if (openTurn) openTurn.users.push(cell);
  else state.orphans.push(cell);
}

function foldAssistantMessage(state: FoldState, event: TrajectoryEvent): void {
  const turn = turnFor(state, event);
  if (!turn) return;
  const bucket = stepOf(turn, event.step);
  bucket.message = messageCell(event);
}

function foldToolCall(state: FoldState, event: TrajectoryEvent): void {
  const turn = turnFor(state, event);
  if (!turn) return;
  state.openTools.set(`${event.turn}\u0000${String(event.data.callId)}`, event);
  const bucket = toolBucket(turn, event.step ?? null);
  bucket.tools.push(toolCellFromCall(event));
}

function foldToolResult(state: FoldState, event: TrajectoryEvent): void {
  const turn = turnFor(state, event);
  if (!turn) return;
  const callId = String(event.data.callId ?? event.seq);
  const key = `${event.turn}\u0000${callId}`;
  const call = state.openTools.get(key);
  if (call) state.openTools.delete(key);
  const durationMs = call ? durationBetween(timeMs(call), timeMs(event)) : null;
  const name = typeof event.data.name === "string" && event.data.name ? event.data.name : "tool";
  const isError = event.data.isError === true;
  const outputChars = typeof event.data.outputChars === "number" ? event.data.outputChars : null;
  // Pair into the call's step bucket when known, else the latest bucket.
  const target =
    call && call.step !== null
      ? (turn.steps.get(call.step) ?? toolBucket(turn, event.step ?? null))
      : toolBucket(turn, event.step ?? null);
  const paired = call
    ? [...target.tools].toReversed().find((tool) => tool.seqs.includes(call.seq))
    : undefined;
  if (paired) {
    // dsh folds call+result into ONE row: update the call row in place.
    const args = typeof call!.data.argSummary === "string" ? truncate(call!.data.argSummary) : null;
    paired.label = toolLabel(name, args);
    paired.durationMs = durationMs;
    paired.outputChars = outputChars;
    paired.isError = isError;
    paired.seqs = [call!.seq, event.seq];
    return;
  }
  if (call) return; // call row not in this bucket (window boundary); nothing observable to update
  // Orphan result (call never seen): its own row, duration unknown.
  target.tools.push({
    kind: "tool",
    label: name,
    durationMs,
    usage: null,
    outputChars,
    isError,
    seq: event.seq,
    seqs: [event.seq],
  });
}

function foldTurnEnd(state: FoldState, event: TrajectoryEvent): void {
  const turn = turnFor(state, event);
  if (!turn) return;
  if (turn.endedAt === null) {
    turn.endedAt = event.time;
    const outcome = event.data.outcome;
    if (outcome === "failed") turn.outcome = "failed";
    else if (outcome === "canceled") turn.outcome = "canceled";
    else turn.outcome = "completed";
    turn.error = typeof event.data.error === "string" ? event.data.error : null;
    const rawUsage = (event.data.usage ?? {}) as Record<string, unknown>;
    const hasAny = Object.values(rawUsage).some((value) => typeof value === "number");
    if (hasAny) turn.usage = usageOf(event.data.usage);
  }
}

/** Turn bucket for an event; creates buckets in encounter order. */
function turnFor(state: FoldState, event: TrajectoryEvent): TurnAcc | null {
  if (event.turn === null) return null;
  let turn = state.turns.get(event.turn);
  if (!turn) {
    turn = newTurn(event.turn);
    state.turns.set(event.turn, turn);
  }
  return turn;
}

/** Step bucket for a step event; creates buckets in encounter order. */
function stepOf(turn: TurnAcc, step: number | null): TrajectoryStep {
  let bucket = turn.steps.get(step);
  if (!bucket) {
    bucket = newStep(step);
    turn.steps.set(step, bucket);
    turn.stepOrder.push(step);
  }
  return bucket;
}

/**
 * Bucket for a tool row: its explicit step, else the most recent step
 * (dsh interleaves tools under the current step), else a null bucket.
 */
function toolBucket(turn: TurnAcc, step: number | null): TrajectoryStep {
  if (step !== null) return stepOf(turn, step);
  for (let i = turn.stepOrder.length - 1; i >= 0; i--) {
    const candidate = turn.stepOrder[i];
    if (candidate !== null) return turn.steps.get(candidate)!;
  }
  return stepOf(turn, null);
}

export function foldSnapshot(
  agentId: string,
  events: readonly TrajectoryEvent[],
  headSeq: number,
): TrajectorySnapshot {
  const state: FoldState = { turns: new Map(), openTools: new Map(), orphans: [] };

  for (const event of events) {
    switch (event.type) {
      case "turn/start":
        foldTurnStart(state, event);
        break;
      case "user/message":
        foldUserMessage(state, event);
        break;
      case "assistant/message":
        foldAssistantMessage(state, event);
        break;
      case "tool/call":
        foldToolCall(state, event);
        break;
      case "tool/result":
        foldToolResult(state, event);
        break;
      case "turn/end":
        foldTurnEnd(state, event);
        break;
      default:
        // step/start, step/end: structural rows; the fold keys off message/tool rows.
        break;
    }
  }

  const orderedTurns: TrajectoryTurn[] = [];
  for (const turn of state.turns.values()) {
    orderedTurns.push({
      turnId: turn.turnId,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      outcome: turn.outcome,
      error: turn.error,
      usage: turn.usage,
      steps: turn.stepOrder.map((step) => turn.steps.get(step)!),
      users: turn.users,
    });
  }

  return { agentId, headSeq, turns: orderedTurns, orphans: state.orphans };
}

/** Incremental refresh: fold the full window each time (rows are cheap, UI memoizes). */
export function refold(
  previous: TrajectorySnapshot,
  newEvents: readonly TrajectoryEvent[],
  headSeq: number,
): TrajectorySnapshot {
  if (newEvents.length === 0) return { ...previous, headSeq };
  // The fold is deterministic; callers pass the full row window (paged reads
  // already fetch it). This helper exists so live updates have one entry point.
  return foldSnapshot(previous.agentId, newEvents, headSeq);
}
