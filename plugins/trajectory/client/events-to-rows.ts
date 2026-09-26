import type { TrajectoryEvent } from "../shared/trajectory.js";
import type { TrajectoryFoldRow } from "../shared/dsh/layout.js";

/**
 * Adapter: ledger events -> dsh fold rows (T2.4 read path).
 *
 * The recorder stores observer-only shapes (lengths, not text). This walk is
 * pure and ascending-seq:
 * - `user/message`   -> user row (`user message (N chars)`).
 * - `assistant/message` -> message row (label per PORT_NOTES case 16); usage
 *   arrives at `turn/end`, so it is attached to the turn's LAST message row
 *   (dsh hangs usage on Message cells).
 * - `tool/call` + `tool/result` pair by callId: a result row renders the
 *   paired label; a call with no result in the window stays in-flight (null
 *   duration -> em dash). call rows are consumed, never double-rendered.
 * - `turn/start` / `step/*` / `turn/end` carry structure or turn-level data,
 *   not rows; step numbers come from the message rows' `step` field.
 */

/** callId -> data from the open tool/call row (ascending seq guarantees order). */
interface OpenToolCall {
  name: string;
  argSummary: string | null;
  timeMs: number | null;
  turnId: string | null;
}

function timeOf(event: TrajectoryEvent): number | null {
  const parsed = Date.parse(event.time);
  return Number.isFinite(parsed) ? parsed : null;
}

function lengthLabel(prefix: string, textLength: unknown): string {
  return typeof textLength === "number" ? `${prefix} (${textLength} chars)` : prefix;
}

function toolLabel(name: string, argSummary: string | null): string {
  return argSummary === null ? name : `${name} · ${argSummary}`;
}

function userRow(event: TrajectoryEvent): TrajectoryFoldRow {
  return {
    seq: event.seq,
    timeMs: timeOf(event),
    kind: "user",
    label: lengthLabel("user message", event.data.textLength),
    durationMs: null,
    ...(event.turn === null ? {} : { turnId: event.turn }),
    step: null,
  };
}

function messageRow(event: TrajectoryEvent): TrajectoryFoldRow {
  return {
    seq: event.seq,
    timeMs: timeOf(event),
    kind: "message",
    label: lengthLabel("assistant message", event.data.textLength),
    durationMs: null,
    ...(event.turn === null ? {} : { turnId: event.turn }),
    ...(event.step === null ? {} : { step: event.step }),
  };
}

function openCallOf(event: TrajectoryEvent): OpenToolCall | null {
  const callId = event.data.callId;
  if (typeof callId !== "string") return null;
  return {
    name: typeof event.data.name === "string" ? event.data.name : "tool",
    argSummary: typeof event.data.argSummary === "string" ? event.data.argSummary : null,
    timeMs: timeOf(event),
    turnId: event.turn,
  };
}

function toolRow(event: TrajectoryEvent, call: OpenToolCall | null): TrajectoryFoldRow | null {
  const callId = event.data.callId;
  if (typeof callId !== "string") return null;
  const name = typeof event.data.name === "string" ? event.data.name : (call?.name ?? "tool");
  const argSummary = call?.argSummary ?? null;
  return {
    seq: event.seq,
    timeMs: timeOf(event),
    kind: "tool",
    label: toolLabel(name, argSummary),
    durationMs: typeof event.data.durationMs === "number" ? event.data.durationMs : null,
    callId,
    ...(event.data.isError === true ? { isError: true } : {}),
    ...(typeof event.data.outputChars === "number" ? { outputChars: event.data.outputChars } : {}),
    ...(event.turn === null ? {} : { turnId: event.turn }),
    step: null,
  };
}

function inFlightRow(call: OpenToolCall): TrajectoryFoldRow {
  return {
    seq: Number.NaN, // replaced by the caller with the call event's seq
    timeMs: call.timeMs,
    kind: "tool",
    label: toolLabel(call.name, call.argSummary),
    durationMs: null,
    callId: "",
    ...(call.turnId === null ? {} : { turnId: call.turnId }),
    step: null,
  };
}

function usageBuckets(usage: unknown): TrajectoryFoldRow["usage"] | null {
  if (typeof usage !== "object" || usage === null) return null;
  const buckets = usage as Record<string, unknown>;
  return {
    input: typeof buckets.inputTokens === "number" ? buckets.inputTokens : null,
    cacheRead: typeof buckets.cachedInputTokens === "number" ? buckets.cachedInputTokens : null,
    cacheWrite: null,
    output: typeof buckets.outputTokens === "number" ? buckets.outputTokens : null,
    think: typeof buckets.reasoningTokens === "number" ? buckets.reasoningTokens : null,
  };
}

function applyTurnUsage(
  rows: TrajectoryFoldRow[],
  lastMessageRowByTurn: Map<string, number>,
  event: TrajectoryEvent,
): void {
  if (event.turn === null) return;
  const buckets = usageBuckets(event.data.usage);
  const index = lastMessageRowByTurn.get(event.turn);
  if (buckets === null || index === undefined) return;
  const row = rows[index];
  if (row === undefined || row.kind !== "message") return;
  rows[index] = { ...row, usage: buckets };
}

export function eventsToFoldRows(events: readonly TrajectoryEvent[]): TrajectoryFoldRow[] {
  const rows: TrajectoryFoldRow[] = [];
  const openCalls = new Map<string, OpenToolCall>();
  /** turnId -> index of the last message row emitted for that turn. */
  const lastMessageRowByTurn = new Map<string, number>();
  /** callId -> its call event, for the in-flight sweep. */
  const callEvents = new Map<string, TrajectoryEvent>();

  for (const event of events) {
    switch (event.type) {
      case "user/message": {
        rows.push(userRow(event));
        break;
      }
      case "assistant/message": {
        if (event.turn !== null) lastMessageRowByTurn.set(event.turn, rows.length);
        rows.push(messageRow(event));
        break;
      }
      case "tool/call": {
        const call = openCallOf(event);
        if (call !== null && typeof event.data.callId === "string") {
          openCalls.set(event.data.callId, call);
          callEvents.set(event.data.callId, event);
        }
        break;
      }
      case "tool/result": {
        const callId = event.data.callId;
        const call = typeof callId === "string" ? (openCalls.get(callId) ?? null) : null;
        if (typeof callId === "string") {
          openCalls.delete(callId);
          callEvents.delete(callId);
        }
        const row = toolRow(event, call);
        if (row !== null) rows.push(row);
        break;
      }
      case "turn/end": {
        applyTurnUsage(rows, lastMessageRowByTurn, event);
        break;
      }
      default:
        // turn/start, step/start, step/end: structure only, no rows.
        break;
    }
  }

  // Calls still open at the window head stay in-flight (em dash), in seq order.
  for (const [callId, event] of callEvents) {
    if (!openCalls.has(callId)) continue;
    const call = openCalls.get(callId);
    if (call === undefined) continue;
    const row = { ...inFlightRow(call), seq: event.seq, callId };
    rows.push(row);
  }

  return rows;
}
