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
 *   paired label and is stamped at the CALL time (its own duration already
 *   spans call->result); a call with no result in the window stays in-flight
 *   (null duration, marked `open`, so the ledger can tick it). call rows are
 *   consumed, never double-rendered.
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

/**
 * The producer's timeline item seq, when it recorded one. It is an integer
 * foreign key in a loosely-typed data blob, so it is read defensively: a row
 * recorded before this existed, or a producer that never sent one, simply has
 * no key and the client keeps showing the length.
 */
function timelineSeqOf(event: TrajectoryEvent): { sourceMessageId?: string } {
  const value = (event.data as { sourceMessageId?: unknown }).sourceMessageId;
  return typeof value === "string" && value.length > 0 ? { sourceMessageId: value } : {};
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
    turnId: event.turn,
    step: null,
    // A user message is recorded once, so its length is the whole prompt. The
    // STATS column shows it directly; there is no delta to compute.
    textLength: numericLength(event.data.textLength),
    ...timelineSeqOf(event),
  };
}

/**
 * Fold a contiguous run of assistant message rows into ONE row.
 *
 * Owner item 11: a single agent response streams in as many `assistant/message`
 * events, each carrying a growing `textLength`. Rendering one row per event
 * produced a flood of "+67 chars" rows with mid-word fragments. A run is the
 * maximal stretch of consecutive message rows with no tool, user, system, llm
 * or round marker between them -- anything else ends it, because the LLM-round
 * marker and a tool call are exactly the boundaries where the model did
 * something new.
 *
 * The merged row keeps:
 * - seq / sourceMessageId of the FIRST segment, so selection, the timeline-strip
 *   outline and the ledger key stay stable and unique across live appends;
 * - timeMs of the first segment and a duration spanning to the last, so the row
 *   covers the whole response;
 * - textLength of the LAST segment, which is the final cumulative length (the
 *   sum of the deltas equals it);
 * - usage from the LAST segment that carried one, because the provider reports
 *   the turn's totals once and they do not sum across segments.
 *
 * Segments that contributed nothing (a +0 re-emission) merge away, and
 * `segments` records how many rows actually stood behind the one row shown.
 */
function mergeMessageRuns(rows: TrajectoryFoldRow[]): TrajectoryFoldRow[] {
  const out: TrajectoryFoldRow[] = [];
  for (const row of rows) {
    const previous = out.at(-1);
    // A thinking run merges by exactly the same rule as a message run: the
    // provider streams reasoning as suffix deltas, so 62 chunks are one thought.
    // A run of either kind ends at anything else, which is what keeps
    // thinking -> text as two rows rather than one.
    if (previous === undefined || !continuesRun(previous, row)) {
      out.push(row);
      continue;
    }
    if (row.kind === "thinking") {
      out[out.length - 1] = mergeThinkingRun(previous, row);
      continue;
    }
    const merged: TrajectoryFoldRow = { ...previous };
    // DISTINCT ids in seq order: one message re-emitted across many chunks is
    // one id, and the detail view should fetch that text once, not per chunk.
    const identities = [
      ...new Set([
        ...(previous.sourceMessageIds ?? [previous.sourceMessageId ?? ""]),
        ...(row.sourceMessageId == null ? [] : [row.sourceMessageId]),
      ]),
    ].filter((id) => id.length > 0);
    merged.sourceMessageIds = identities;
    merged.segments = (previous.segments ?? 1) + 1;
    // The last segment's cumulative length IS the response total.
    if (row.textLength !== undefined && row.textLength !== null) {
      merged.textLength = row.textLength;
      merged.label = lengthLabel("assistant message", row.textLength);
    }
    // A row that only re-stated what was already there contributes no time.
    if (row.timeMs !== null && previous.timeMs !== null) {
      merged.durationMs = Math.max(0, row.timeMs - previous.timeMs);
    } else if (row.timeMs !== null) {
      merged.timeMs = row.timeMs;
    }
    if (row.usage !== undefined) {
      merged.usage = row.usage;
    }
    // Keep the FIRST delta offset so the composed preview starts at the
    // beginning of the response.
    merged.deltaStart = previous.deltaStart ?? 0;
    merged.deltaChars = previous.deltaChars;
    out[out.length - 1] = merged;
  }
  return out;
}

/**
 * Whether two adjacent rows belong to the same run.
 *
 * A MESSAGE run is one agent response, and a response is identified by its
 * source message id -- NOT by its turn. QC r20: providers reuse their turn ids
 * across sessions (b1b's ledger uses `opencode-turn-0` for two different turns,
 * 95 assistant rows sharing 34 turn+step identities), and only step/start and
 * step/end sit between those turns. Keying the run on turnId therefore welded
 * the newest response onto the previous one: the merged row kept its identity,
 * only its text grew, and the DOM showed no new row at all. The source id is
 * the stable per-response identity, so it is what ends or continues a run.
 *
 * Anything else still ends a run: a tool, a user row, an llm round marker, or
 * the other kind. That keeps thinking -> text as two rows.
 *
 * THINKING has no source id (the provider sends none), so its run is plain
 * contiguity within a turn. A reused turn id can in principle weld two thoughts
 * together; recording a per-part id upstream is what would fix that, and nothing
 * here pretends otherwise.
 */
function continuesRun(previous: TrajectoryFoldRow, row: TrajectoryFoldRow): boolean {
  if (previous.kind !== row.kind) return false;
  if (previous.turnId !== row.turnId) return false;
  if (row.kind === "thinking") return true;
  if (row.kind !== "message") return false;
  const previousId = previous.sourceMessageId;
  const nextId = row.sourceMessageId;
  if (previousId === undefined || nextId === undefined) return true;
  return previousId === nextId;
}

/**
 * Collapse a contiguous run of reasoning chunks into one row.
 *
 * `thinking/message` carries a SUFFIX (opencode emits only what was appended to
 * the part, opencode-agent.ts:2912-2922), so the run's total is the SUM of its
 * segments rather than the last one's length. Reasoning has no source id, so
 * there is nothing to compose for the detail view -- the size is the whole
 * record, and that is already the documented limit.
 */
function mergeThinkingRun(previous: TrajectoryFoldRow, row: TrajectoryFoldRow): TrajectoryFoldRow {
  const segments = (previous.segments ?? 1) + 1;
  const before = previous.textLength;
  const added = row.textLength;
  // An unknown length anywhere means the total is unknown; summing around it
  // would invent a number.
  const total =
    before !== undefined && before !== null && added !== undefined && added !== null
      ? before + added
      : null;
  return {
    ...previous,
    textLength: total,
    label:
      total === null
        ? "reasoning · — chars total"
        : `reasoning · ${total.toLocaleString("en-US")} chars total`,
    segments,
    durationMs:
      previous.timeMs !== null && row.timeMs !== null
        ? Math.max(0, row.timeMs - previous.timeMs)
        : null,
  };
}

/** `textLength` when the producer sent a real number, else null. Never coerced. */
function numericLength(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One `assistant/message` row, carrying THIS event's contribution rather than
 * the message total.
 *
 * The daemon re-emits an assistant message on every stream chunk with the same
 * `sourceMessageId` and a growing `textLength` — a single message can arrive as
 * over a hundred rows. Rendering the cumulative label would repeat the whole
 * message on every one of those rows, so each row instead carries the slice it
 * added. `cumulative` is the length seen on the previous row for this message,
 * which is what the row's delta is measured from.
 */
function messageRow(event: TrajectoryEvent, cumulative: Map<string, number>): TrajectoryFoldRow {
  const identity = timelineSeqOf(event);
  const total = numericLength(event.data.textLength);
  const sourceMessageId = identity.sourceMessageId;
  let textLength: number | null = null;
  let deltaChars: number | null = null;
  let deltaStart: number | undefined;
  if (total !== null && sourceMessageId !== undefined) {
    const previous = cumulative.get(sourceMessageId) ?? 0;
    // A shrinking total would mean the producer reset mid-message; report no
    // delta rather than a negative one, and let the label stand.
    deltaChars = total >= previous ? total - previous : null;
    deltaStart = previous;
    textLength = total;
    cumulative.set(sourceMessageId, total);
  }
  return {
    seq: event.seq,
    timeMs: timeOf(event),
    kind: "message",
    label: lengthLabel("assistant message", event.data.textLength),
    durationMs: null,
    turnId: event.turn,
    step: event.step,
    segments: 1,
    // Always populated when an id exists, merged or not, so a consumer reads one
    // field rather than branching on whether the row ever merged.
    ...(sourceMessageId === undefined ? {} : { sourceMessageIds: [sourceMessageId] }),
    ...(textLength === null ? {} : { textLength }),
    ...(deltaChars === null ? {} : { deltaChars }),
    ...(deltaStart === undefined ? {} : { deltaStart }),
    ...identity,
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
    // The CALL time, not the result time: a tool row's own duration already
    // spans call->result, so pairing it with the result stamp made every tool
    // look like it started when it finished (and put the group's wall span one
    // duration too late). dsh anchors a tool cell at `callTime` for the same
    // reason (dsh layout.ts:437 for the cell's absTime, :455 for startedAt).
    //
    // A result whose call the recorder never observed does reach here — it
    // backfills a `tool/call` (flagged `data.backfilled`) immediately before the
    // result — so this fallback fires on a reconstructed call, and the stamp it
    // uses is the reconstruction instant rather than a true start. Nothing else
    // is available at that point, and the alternative (pretending it never
    // started) would lose the row's position in the list.
    timeMs: call?.timeMs ?? timeOf(event),
    kind: "tool",
    label: toolLabel(name, argSummary),
    durationMs: typeof event.data.durationMs === "number" ? event.data.durationMs : null,
    callId,
    ...(event.data.isError === true ? { isError: true } : {}),
    ...(typeof event.data.outputChars === "number" ? { outputChars: event.data.outputChars } : {}),
    turnId: event.turn,
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
    // Observed start, no result yet: the one row whose running time is still
    // climbing, so it is the one row allowed to show a live elapsed.
    open: true,
    callId: "",
    turnId: call.turnId,
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

/**
 * A derived LLM-round row.
 *
 * The recorder emits this when tool results are waiting and the agent's next
 * action begins, so the label states the falsifiable claim rather than
 * pretending to know the provider's internals: "these N results were consumed
 * before this round".
 */
function roundRow(event: TrajectoryEvent): TrajectoryFoldRow {
  const consumed = numericLength(event.data.consumedResults) ?? 0;
  const ordinal = numericLength(event.data.ordinal);
  return {
    seq: event.seq,
    timeMs: timeOf(event),
    kind: "llm",
    label:
      ordinal === null
        ? `llm round · consumed ${consumed} results`
        : `llm round ${ordinal} · consumed ${consumed} results`,
    durationMs: null,
    turnId: event.turn,
    step: null,
    ...(typeof event.data.derived === "boolean" ? { derived: true } : {}),
  };
}

/**
 * Injected system context, as a size and a hash. The prompt text is never in
 * the ledger, so there is nothing to leak into this row either.
 *
 * One row shape for both injections the daemon can apply before a session
 * exists: what the caller configured (`system prompt`) and what the daemon
 * appends to every session (`daemon instructions`). A row written before
 * `source` existed is a caller prompt, so an absent field reads as `caller`
 * rather than as unknown.
 */
function systemPromptRow(event: TrajectoryEvent): TrajectoryFoldRow {
  const chars = numericLength(event.data.charsLength);
  const hash = typeof event.data.hash12 === "string" ? event.data.hash12 : null;
  const parts = [
    `${event.data.source === "daemon-append" ? "daemon instructions" : "system prompt"} · ${
      chars === null ? "— chars" : `${chars.toLocaleString("en-US")} chars`
    }`,
  ];
  if (hash !== null) parts.push(`hash ${hash}…`);
  return {
    seq: event.seq,
    timeMs: timeOf(event),
    kind: "systemPrompt",
    label: parts.join(" · "),
    durationMs: null,
    turnId: null,
    step: null,
    ...(typeof event.data.derived === "boolean" ? { derived: true } : {}),
  };
}

/**
 * Provider reasoning, as a length.
 *
 * The row never carries text: reasoning reaches the recorder without a message
 * id, so there is no source key to fetch the body with later. Recording the
 * size is the honest maximum -- see the recorder's note on the missing key.
 */
function thinkingRow(event: TrajectoryEvent): TrajectoryFoldRow {
  const chars = numericLength(event.data.textLength);
  return {
    seq: event.seq,
    timeMs: timeOf(event),
    kind: "thinking",
    label:
      chars === null ? "reasoning · — chars" : `reasoning · ${chars.toLocaleString("en-US")} chars`,
    durationMs: null,
    turnId: event.turn,
    step: null,
    textLength: chars,
  };
}

export function eventsToFoldRows(events: readonly TrajectoryEvent[]): TrajectoryFoldRow[] {
  const rows: TrajectoryFoldRow[] = [];
  const openCalls = new Map<string, OpenToolCall>();
  /** turnId -> index of the last message row emitted for that turn. */
  const lastMessageRowByTurn = new Map<string, number>();
  /** callId -> its call event, for the in-flight sweep. */
  const callEvents = new Map<string, TrajectoryEvent>();
  /**
   * sourceMessageId -> the cumulative `textLength` of its most recent row.
   * Ascending seq makes this a single forward pass, which is the only place a
   * per-row delta can be measured without re-reading the stream.
   */
  const messageCumulative = new Map<string, number>();

  for (const event of events) {
    switch (event.type) {
      case "user/message": {
        rows.push(userRow(event));
        break;
      }
      case "assistant/message": {
        if (event.turn !== null) lastMessageRowByTurn.set(event.turn, rows.length);
        rows.push(messageRow(event, messageCumulative));
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
      case "thinking/message": {
        rows.push(thinkingRow(event));
        break;
      }
      case "round/begin": {
        rows.push(roundRow(event));
        break;
      }
      case "system/attach": {
        rows.push(systemPromptRow(event));
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

  return mergeMessageRuns(rows);
}
