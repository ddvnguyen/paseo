/**
 * Trajectory list fold, part 1 of 3: public model + shared helpers.
 *
 * Ported from DeepSeek deepseek-harness `packages/client/ui-trajectory/src/client/layout.ts`
 * (llm-server-monitoring repo, commit afd92680f2, MIT License — Copyright (c) 2026 DeepSeek).
 *
 * Retargeting for paseo (observer-only): the dsh runtime node model
 * (ConversationSnapshot, RequestView, ToolCallBlock, ToolResultNode,
 * PartialAssistant) is replaced by OUR ledger fold — the rows already carry
 * paired tool call/result, usage buckets, and per-row durations. The fields
 * our recorder cannot supply (per the accepted T2.0 gap map) are dropped from
 * the input model: request-inspection (system-prompt snapshots, tool schemas),
 * compaction requests, context slots, event locations, sub-calls, TTFT
 * timings. In-flight rows arrive as ledger rows with null durations and render
 * "—" via the unchanged dsh formatters.
 */

import type { TrajectoryCellProps } from "./record.ts";
import { formatElapsedSeconds } from "./record.ts";

/** One Message or Step group inside a turn. */
export interface TrajectoryGroupModel {
  title: string;
  description?: string;
  cells: readonly TrajectoryCellProps[];
}

/** Disjoint provider token buckets for one turn. */
export interface TrajectoryTurnUsage {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  think?: number;
}

/** One sticky turn, or a standalone compaction section between turns. */
export interface TrajectoryTurnModel {
  turn: number | null;
  groups: readonly TrajectoryGroupModel[];
  /** Aggregated token usage across all cells in the turn. */
  usage?: TrajectoryTurnUsage;
}

/** Cell plus absolute ms for group wall-span descriptions. */
export interface LaidCell {
  cell: TrajectoryCellProps;
  absTime: number | null;
  toolName?: string;
  callId?: string;
}

/** The paseo ledger fold: one row per event, already paired and usage-stamped. */
export interface TrajectoryFoldRow {
  seq: number;
  /** Absolute epoch ms when the row happened, when known. */
  timeMs: number | null;
  kind: "system" | "user" | "message" | "tool" | "llm" | "systemPrompt" | "thinking";
  /** Short single-line summary (tool rows: `name · args`). */
  label: string;
  /** Own duration ms, null while in-flight / unknown. */
  durationMs: number | null;
  /**
   * True while the row is still running (a tool call whose result has not
   * arrived). dsh derives the same state from a missing output payload; we carry
   * it explicitly so the ledger can show a running time that ticks instead of an
   * em dash, and the detail view can say Pending.
   */
  open?: boolean;
  /** Tool call id linking call+result rows. */
  callId?: string;
  /** Tool rows only: failure state. */
  isError?: boolean;
  /** Tool rows only: result character count. */
  outputChars?: number | null;
  /**
   * Identity of the daemon timeline item this row came from. A foreign key the
   * recorder persists so the client can fetch this row's text on demand; absent
   * on rows recorded before it existed, and when the producer sent no id.
   */
  sourceMessageId?: string | null;
  /** Message rows only: token buckets from the provider. */
  usage?: {
    input: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    output: number | null;
    think: number | null;
  };
  /**
   * The source identities folded into this row, in seq order.
   *
   * A single agent response arrives as many `assistant/message` events and is
   * merged into one row, so a merged row can span more than one message id.
   * Per-segment ids are kept here so the detail view can fetch and compose each
   * one; `sourceMessageId` stays the FIRST segment's, which is the stable
   * selection identity the timeline strip and the ledger highlight against.
   */
  sourceMessageIds?: string[];
  /** How many events this row merged; 1 for an unmerged row. */
  segments?: number;
  /** Turn id string from the ledger; null rows fold into the enclosing turn. */
  turnId: string | null;
  /** Step number within the turn, when the provider reports one. */
  step: number | null;
  /**
   * True when the recorder derived this row rather than observing it (an LLM
   * round boundary, the system prompt). Kept on the row so a reader can tell an
   * inferred fact from an observed one instead of taking both at face value.
   */
  derived?: boolean;
  /**
   * Cumulative character count of the message as of THIS event. The daemon
   * re-emits `assistant/message` on every stream chunk with a growing
   * `textLength`, so this is the total-so-far, not this row's contribution.
   */
  textLength?: number | null;
  /**
   * Characters THIS event contributed: `textLength` minus the value carried by
   * the previous row with the same `sourceMessageId`. The first row of a
   * message counts from zero, so its delta is the whole opening chunk.
   * Null when the length is unknown or the row carries no source identity —
   * in which case the row keeps its plain length label and nothing is invented.
   */
  deltaChars?: number | null;
  /**
   * Cumulative length BEFORE this event, i.e. the offset the delta starts at.
   * With `deltaChars` this gives the added slice of a resolved text as
   * `resolvedText.slice(deltaStart, deltaStart + deltaChars)`.
   */
  deltaStart?: number;
}

/** Snapshot slice the trajectory view folds (paseo shape). */
export interface TrajectoryLayoutInput {
  /** Ledger fold rows in seq order for one agent. */
  rows: readonly TrajectoryFoldRow[];
  /** Turn id -> numeric turn number for display (order of appearance = 1..N when absent). */
  turnNumbers?: ReadonlyMap<string, number>;
  /** Rows the caller already knows are in-flight (open tool call). */
  openCallIds?: ReadonlySet<string>;
}

/** Own-duration seconds from two epoch-ms stamps; null when either is unusable. */
export function durationSeconds(later: number | null, earlier: number | null): number | null {
  if (earlier === null || later === null || !Number.isFinite(later) || !Number.isFinite(earlier))
    return null;
  return Math.max(0, (later - earlier) / 1000);
}

/** Epoch-ms usable as an absolute time, else null. */
/**
 * Propagate a row's source identity to its cell. A row recorded before the
 * identity existed, or from a producer that sent none, simply has no key — and a
 * single helper keeps that rule in one place for both cell kinds.
 */
/** Copy the per-row delta facts onto a cell, omitting them when unknown. */
function deltaFields(row: TrajectoryFoldRow): {
  textLength?: number;
  deltaChars?: number;
  deltaStart?: number;
} {
  if (row.textLength === undefined || row.textLength === null) return {};
  if (row.deltaChars === undefined || row.deltaChars === null)
    return { textLength: row.textLength };
  return {
    textLength: row.textLength,
    deltaChars: row.deltaChars,
    deltaStart: row.deltaStart ?? 0,
  };
}

function sourceIdentity(row: TrajectoryFoldRow): { sourceMessageId?: string } {
  if (row.sourceMessageId === undefined || row.sourceMessageId === null) return {};
  return { sourceMessageId: row.sourceMessageId };
}

/** Merged-response facts, so the detail view can compose what one row folded. */
function mergedIdentity(row: TrajectoryFoldRow): {
  sourceMessageIds?: string[];
  segments?: number;
} {
  const ids = row.sourceMessageIds ?? [];
  return {
    ...(ids.length === 0 ? {} : { sourceMessageIds: ids }),
    ...(row.segments === undefined ? {} : { segments: row.segments }),
  };
}

export function finiteTime(time: number | null | undefined): number | null {
  return typeof time === "number" && Number.isFinite(time) ? time : null;
} /** Wall-span duration + tool histogram, e.g. `1.5 s bash×6`. */
export function groupDescription(laid: readonly LaidCell[]): string | undefined {
  const parts: string[] = [];
  appendGroupSpan(parts, laid);
  appendToolHistogram(parts, laid);
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** Tool rows contribute start (absTime) and end (start + own duration) so a
 * single Tool cell still spans call→result for the group wall clock. */
function appendGroupSpan(parts: string[], laid: readonly LaidCell[]): void {
  const times: number[] = [];
  for (const l of laid) {
    if (l.absTime === null || !Number.isFinite(l.absTime)) continue;
    times.push(l.absTime);
    if (
      l.cell.kind === "tool" &&
      l.cell.timeSeconds !== null &&
      Number.isFinite(l.cell.timeSeconds)
    ) {
      times.push(l.absTime + l.cell.timeSeconds * 1000);
    }
  }
  if (times.length >= 2) {
    const span = formatGroupDuration((Math.max(...times) - Math.min(...times)) / 1000);
    if (span !== undefined) parts.push(span);
  } else if (times.length === 1) {
    const own = laid.find((l) => l.absTime === times[0])?.cell.timeSeconds;
    const span = own !== null && own !== undefined ? formatGroupDuration(own) : undefined;
    if (span !== undefined) parts.push(span);
  }
}

function appendToolHistogram(parts: string[], laid: readonly LaidCell[]): void {
  const tools = new Map<string, number>();
  for (const l of laid) {
    if (l.toolName === undefined || l.cell.kind !== "tool") continue;
    tools.set(l.toolName, (tools.get(l.toolName) ?? 0) + 1);
  }
  for (const [name, count] of tools) {
    parts.push(count > 1 ? `${name}×${count}` : name);
  }
}

function formatGroupDuration(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) return undefined;
  return formatElapsedSeconds(seconds);
}

/** Copy provider usage onto a Message cell when present. */
export function attachUsage(cell: TrajectoryCellProps, usage: TrajectoryFoldRow["usage"]): void {
  if (usage === undefined) return;
  if (usage.input !== null) cell.input = usage.input;
  if (usage.cacheRead !== null) cell.cacheRead = usage.cacheRead;
  if (usage.cacheWrite !== null) cell.cacheWrite = usage.cacheWrite;
  if (usage.output !== null) cell.output = usage.output;
  if (usage.think !== null) cell.think = usage.think;
}

export function sumTurnUsage(
  groups: readonly TrajectoryGroupModel[],
): TrajectoryTurnUsage | undefined {
  const usage: TrajectoryTurnUsage = {};
  let hasUsage = false;
  for (const group of groups) {
    for (const cell of group.cells) {
      if (cell.input !== undefined) {
        usage.input = (usage.input ?? 0) + cell.input;
        hasUsage = true;
      }
      if (cell.cacheRead !== undefined) {
        usage.cacheRead = (usage.cacheRead ?? 0) + cell.cacheRead;
        hasUsage = true;
      }
      if (cell.cacheWrite !== undefined) {
        usage.cacheWrite = (usage.cacheWrite ?? 0) + cell.cacheWrite;
        hasUsage = true;
      }
      if (cell.output !== undefined) {
        usage.output = (usage.output ?? 0) + cell.output;
        hasUsage = true;
      }
      if (cell.think !== undefined) {
        usage.think = (usage.think ?? 0) + cell.think;
        hasUsage = true;
      }
    }
  }
  return hasUsage ? usage : undefined;
}

export function toTurnModel(turn: number | null, entry: TurnBucket): TrajectoryTurnModel {
  const groups = entry.groups.map(({ title, laid }): TrajectoryGroupModel => {
    const description = groupDescription(laid);
    return {
      title,
      ...(description !== undefined ? { description } : {}),
      cells: laid.map((l) => l.cell),
    };
  });
  const usage = sumTurnUsage(groups);
  return { turn, groups, ...(usage !== undefined ? { usage } : {}) };
}

/** Chronological section position from the fold's monotonically assigned cell indexes. */
export function firstCellIndex(turn: TrajectoryTurnModel): number {
  return Math.min(
    ...turn.groups.flatMap((group) => group.cells.map((cell) => cell.index)),
    Number.POSITIVE_INFINITY,
  );
}

export interface TurnBucket {
  groups: LaidGroup[];
}

export interface LaidGroup {
  title: string;
  laid: LaidCell[];
}

/** Turn id -> display number: caller map, else order of first appearance (1..N). */
export function turnNumbersFor(
  rows: readonly TrajectoryFoldRow[],
  explicit?: ReadonlyMap<string, number>,
): Map<string, number> {
  const numbers = new Map<string, number>();
  if (explicit !== undefined) {
    for (const [id, number] of explicit) numbers.set(id, number);
    return numbers;
  }
  for (const row of rows) {
    if (row.turnId === null || numbers.has(row.turnId)) continue;
    numbers.set(row.turnId, numbers.size + 1);
  }
  return numbers;
}

/** Derive the shared tool label pieces from a fold row. */
export function toolLabelParts(row: TrajectoryFoldRow): { toolName: string; preview?: string } {
  const label = row.label;
  const separator = label.indexOf(" · ");
  const toolName = separator === -1 ? label : label.slice(0, separator);
  const preview = separator === -1 ? undefined : label.slice(separator + 3);
  return { toolName, preview };
}

// ---------------------------------------------------------------------------
// Part 2: the fold itself (dsh deriveTrajectoryLayout, retargeted).
// ---------------------------------------------------------------------------

/**
 * Fold ledger rows into turn → Message/Step groups with expanded cells.
 * Mirrors dsh structure: Message groups hold user rows; Step groups hold
 * assistant message + tool rows; turn usage sums the Message buckets.
 * @param input - Ledger fold rows plus optional turn numbering.
 * @returns Turns ordered by first appearance.
 */
export function deriveTrajectoryLayout(
  input: TrajectoryLayoutInput,
): readonly TrajectoryTurnModel[] {
  const { rows, turnNumbers: explicitNumbers } = input;
  const numbers = turnNumbersFor(rows, explicitNumbers);

  // Keyed by the model's own turn number; the key `null` is the unnumbered
  // preamble bucket that holds rows recorded with no turn (the system prompt).
  const turns = new Map<number | null, TurnBucket>();
  let index = 0;

  const bucket = (turn: number | null): TurnBucket => {
    let entry = turns.get(turn);
    if (entry === undefined) {
      entry = { groups: [] };
      turns.set(turn, entry);
    }
    return entry;
  };

  const pushMessage = (turn: number | null, laid: LaidCell): void => {
    const groups = bucket(turn).groups;
    const last = groups.at(-1);
    if (last?.title === "Message") {
      last.laid.push(laid);
      return;
    }
    groups.push({ title: "Message", laid: [laid] });
  };

  const pushStep = (turn: number | null, step: number | null, laid: LaidCell): void => {
    // A null turn means the unnumbered preamble bucket; steps never live there.
    if (step === null || turn === null) {
      pushMessage(turn, laid);
      return;
    }
    const groups = bucket(turn).groups;
    const title = `Step ${step}`;
    const existing = groups.find((group) => group.title === title);
    if (existing !== undefined) {
      existing.laid.push(laid);
      return;
    }
    groups.push({ title, laid: [laid] });
  };

  // dsh folds user rows into the turn they arrived in; our ledger already
  // carries the enclosing turnId, so no following-assistant lookup is needed.
  for (const row of rows) {
    const displayTurn = row.turnId === null ? null : (numbers.get(row.turnId) ?? null);
    index += 1;
    const absTime = finiteTime(row.timeMs);
    if (row.kind === "user") {
      if (displayTurn === null) continue;
      pushMessage(displayTurn, {
        absTime,
        cell: {
          index,
          kind: "user",
          text: row.label,
          sourceSeq: row.seq,
          ...sourceIdentity(row),
          ...(row.textLength === undefined || row.textLength === null
            ? {}
            : { textLength: row.textLength }),
          opensTurn: true,
          timeSeconds: 0,
          startedAt: absTime,
        },
      });
      continue;
    }
    if (row.kind === "message") {
      if (displayTurn === null) continue;
      pushStep(displayTurn, row.step, {
        absTime,
        cell: assistantMessageCell(row, index, absTime),
      });
      continue;
    }
    if (row.kind === "tool") {
      if (displayTurn === null) continue;
      const { toolName, preview } = toolLabelParts(row);
      pushStep(displayTurn, row.step, {
        absTime,
        toolName,
        callId: row.callId,
        cell: {
          index,
          kind: "tool",
          sourceSeq: row.seq,
          text: toolName,
          ...(preview === undefined ? {} : { previewMarkdown: preview }),
          callId: row.callId,
          ...(row.isError === true ? { isError: true } : {}),
          ...(row.outputChars !== undefined && row.outputChars !== null
            ? { result: `${row.outputChars} chars` }
            : {}),
          // In-flight rows keep timeSeconds null and render the dsh em dash, and
          // stay open so the renderer can tick their running time.
          timeSeconds: rowEndSeconds(row, absTime),
          startedAt: absTime,
          ...(row.open === true ? { open: true } : {}),
        },
      });
      continue;
    }
    const derived = plainCell(row, index, absTime);
    if (derived !== null) {
      // A derived round belongs to its turn; the system prompt has no turn and
      // goes to the unnumbered preamble bucket ahead of Turn 1. Both are
      // rendered — there is a recorded fact to show in each case.
      if (derived.cell.kind === "systemPrompt") pushMessage(null, derived.placed);
      else if (displayTurn !== null) pushStep(displayTurn, null, derived.placed);
      continue;
    }
    // 'system' remains the ported dsh kind: the gap map drops system-prompt
    // snapshots, and it stays reachable for the RN renderer via fixtures only.
    // The recorded system prompt arrives as 'systemPrompt' above.
  }

  return [...turns.entries()]
    .map(([turn, entry]) => toTurnModel(turn, entry))
    .sort((left, right) => firstCellIndex(left) - firstCellIndex(right));
}

/**
 * The assistant-message cell: usage buckets and the assistant metrics the
 * details panel reads. Split out of the fold so the fold's own complexity does
 * not grow with every field a message row carries.
 */
function assistantMessageCell(
  row: TrajectoryFoldRow,
  index: number,
  absTime: number | null,
): TrajectoryCellProps {
  const cell: TrajectoryCellProps = {
    index,
    kind: "message",
    sourceSeq: row.seq,
    ...sourceIdentity(row),
    ...mergedIdentity(row),
    text: row.label,
    ...deltaFields(row),
    // Unique per RECORDED ROW, not per (turn, step).
    //
    // This used to be `assistant\0${turnId}\0${step}`, which is unique only
    // inside one turn. Providers reuse their turn ids across sessions -- QC r20
    // measured `opencode-turn-0` used by two different turns, and b1b's ledger
    // has 95 assistant rows sharing just 34 of those ids. Everything downstream
    // keys on the record id: the virtualizer's dedupe in ledger-screen DROPS the
    // later row outright (so the newest message cells rendered no DOM at all),
    // and the search index OVERWRITES the earlier row's text (so it stopped being
    // findable). Both symptoms, one cause.
    //
    // `seq` is the ledger's own DB-assigned id: unique, monotonic, stable across
    // a live append. A merged response keeps the first segment's seq, which is
    // exactly the identity selection and the timeline outline already use.
    recordId: `assistant\u0000${row.seq}`,
    timeSeconds: rowEndSeconds(row, absTime),
    startedAt: absTime,
  };
  attachUsage(cell, row.usage);
  cell.assistantMetrics = {
    timingRecorded: row.durationMs !== null,
    stepStartTime: absTime,
    firstTokenTime: null, // observer-only: no TTFT
    completedTime: rowEndTimeMs(row, absTime),
    usageProvided: row.usage !== undefined,
    outputTokens: row.usage?.output ?? null,
  };
  return cell;
}

/**
 * A cell for the simple row kinds: the two the recorder DERIVES (an LLM round
 * boundary, the system prompt) and provider reasoning, which is OBSERVED.
 *
 * They share one shape -- a label, no usage, no metrics -- so they build here
 * instead of growing the fold's branch count. Only reasoning carries an own
 * duration (see below). Returns null for an ordinary row.
 */
function plainCell(
  row: TrajectoryFoldRow,
  index: number,
  absTime: number | null,
): { cell: TrajectoryCellProps; placed: LaidCell } | null {
  if (row.kind !== "llm" && row.kind !== "systemPrompt" && row.kind !== "thinking") return null;
  const cell: TrajectoryCellProps = {
    index,
    kind: row.kind,
    sourceSeq: row.seq,
    text: row.label,
    // The two DERIVED kinds have no own duration: a round boundary and a system
    // prompt are inferred moments between real records, so there is nothing to
    // measure. Reasoning is the odd one out — it is observed, and a merged run
    // spans its stream events, so it carries the same own duration a message row
    // does. Dropping it here is what left reasoning rows reading "—" in the
    // ledger's running-time column while every other streamed row had one.
    timeSeconds: row.kind === "thinking" ? rowEndSeconds(row, absTime) : null,
    startedAt: absTime,
  };
  return { cell, placed: { absTime, cell } };
}

/**
 * Own-duration seconds for a row, folded from its stamps.
 *
 * Falls back to the recorded duration when the row has no usable absolute stamp:
 * the recorder measured that span on its own clock, so losing the start does not
 * unmeasure it. Without the fallback the ledger's column and the detail panel
 * disagreed about the same row — one showed a dash, the other a duration.
 */
function rowEndSeconds(row: TrajectoryFoldRow, absTime: number | null): number | null {
  if (absTime === null) return row.durationMs === null ? null : Math.max(0, row.durationMs / 1_000);
  return durationSeconds(rowEndTimeMs(row, absTime), absTime);
}

/** Epoch-ms when a row with a known own-duration ends; null when unknown. */
function rowEndTimeMs(row: TrajectoryFoldRow, absTime: number | null): number | null {
  if (row.durationMs === null || absTime === null) return null;
  return absTime + row.durationMs;
}
