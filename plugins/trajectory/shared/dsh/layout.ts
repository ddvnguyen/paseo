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
  kind: "system" | "user" | "message" | "tool";
  /** Short single-line summary (tool rows: `name · args`). */
  label: string;
  /** Own duration ms, null while in-flight / unknown. */
  durationMs: number | null;
  /** Tool call id linking call+result rows. */
  callId?: string;
  /** Tool rows only: failure state. */
  isError?: boolean;
  /** Tool rows only: result character count. */
  outputChars?: number | null;
  /** Message rows only: token buckets from the provider. */
  usage?: {
    input: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    output: number | null;
    think: number | null;
  };
  /** Turn id string from the ledger; null rows fold into the enclosing turn. */
  turnId: string | null;
  /** Step number within the turn, when the provider reports one. */
  step: number | null;
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

  const turns = new Map<number, TurnBucket>();
  let index = 0;

  const bucket = (turn: number): TurnBucket => {
    let entry = turns.get(turn);
    if (entry === undefined) {
      entry = { groups: [] };
      turns.set(turn, entry);
    }
    return entry;
  };

  const pushMessage = (turn: number, laid: LaidCell): void => {
    const groups = bucket(turn).groups;
    const last = groups.at(-1);
    if (last?.title === "Message") {
      last.laid.push(laid);
      return;
    }
    groups.push({ title: "Message", laid: [laid] });
  };

  const pushStep = (turn: number, step: number | null, laid: LaidCell): void => {
    if (step === null) {
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
          opensTurn: true,
          timeSeconds: 0,
          startedAt: absTime,
        },
      });
      continue;
    }
    if (row.kind === "message") {
      const cell: TrajectoryCellProps = {
        index,
        kind: "message",
        sourceSeq: row.seq,
        text: row.label,
        recordId: `assistant\u0000${row.turnId ?? ""}\u0000${row.step ?? 0}`,
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
      if (displayTurn === null) continue;
      pushStep(displayTurn, row.step, { absTime, cell });
      continue;
    }
    if (row.kind === "tool") {
      const { toolName, preview } = toolLabelParts(row);
      const cell: TrajectoryCellProps = {
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
        // In-flight rows keep timeSeconds null and render the dsh em dash.
        timeSeconds: rowEndSeconds(row, absTime),
        startedAt: absTime,
      };
      if (displayTurn === null) continue;
      pushStep(displayTurn, row.step, { absTime, toolName, callId: row.callId, cell });
      continue;
    }
    // 'system': the gap map drops system-prompt snapshots; the kind stays
    // reachable for the RN renderer via fixtures only.
  }

  return [...turns.entries()]
    .map(([turn, entry]) => toTurnModel(turn, entry))
    .sort((left, right) => firstCellIndex(left) - firstCellIndex(right));
}

/** Epoch-ms when a row with a known own-duration ends; null when unknown. */
function rowEndTimeMs(row: TrajectoryFoldRow, absTime: number | null): number | null {
  if (row.durationMs === null || absTime === null) return null;
  return absTime + row.durationMs;
}

/** Own-duration seconds for a row, folded from its stamps. */
function rowEndSeconds(row: TrajectoryFoldRow, absTime: number | null): number | null {
  return durationSeconds(rowEndTimeMs(row, absTime), absTime);
}
