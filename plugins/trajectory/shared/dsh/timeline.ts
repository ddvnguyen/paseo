/** Operation-sequence and recorded-time projections for the trajectory overview.
 *
 * Ported from DeepSeek deepseek-harness `packages/client/ui-trajectory/src/client/timeline.ts`
 * (llm-server-monitoring repo, commit afd92680f2, MIT License — Copyright (c) 2026 DeepSeek).
 * Change from upstream: only the import path (`./layout.ts`, `./record.ts`).
 * `TrajectoryTurnModel` is the ported layout model; no DOM anywhere.
 */

import type { TrajectoryTurnModel } from "./layout.ts";
import { formatDurationMillis } from "./record.ts";
import type { TrajectoryCellKind, TrajectoryCellProps } from "./record.ts";

/** Horizontal projection used by the trajectory timeline. */
export type TrajectoryTimelineMode = "sequence" | "duration" | "time" | "actual";

/** Inclusive selection in the active timeline projection's domain. */
export interface TrajectoryTimeRange {
  start: number;
  end: number;
}

/** One ledger record projected into the active timeline domain. */
export interface TrajectoryTimelineSpan extends TrajectoryTimeRange {
  /** The ledger cell this span projects (`cell.index`). */
  index: number;
  /**
   * The cell's source event seq (`cell.sourceSeq`), carried so a span can be
   * matched against the ledger's selection.
   *
   * `index` and `sourceSeq` are different identities: `index` is assigned while
   * folding and is positional, while the ledger selects by `sourceSeq` because
   * that is the row identity that survives a live append. A strip that only knew
   * `index` could not tell which span is selected without rebuilding the fold's
   * cell indexes, so the bridge travels with the span. Absent on records the
   * producer gave no seq for — those spans are not selectable, only hoverable.
   */
  sourceSeq?: number;
  /**
   * The record's own duration in ms, or null when unknown (in-flight). Carried
   * because a span's `start`/`end` are positions in the *active projection* —
   * in `sequence` mode they are ordinal indices with no time in them at all —
   * so the tooltip's duration cannot be recovered from the span's own geometry.
   */
  durationMs: number | null;
  isError: boolean;
  kind: TrajectoryCellKind;
  label: string;
  lane: number;
}

/** One turn boundary in the active timeline domain. */
export interface TrajectoryTimelineTurnBoundary {
  turn: number | null;
  time: number;
}

/** Full-domain model used by the overview. */
export interface TrajectoryTimelineModel extends TrajectoryTimeRange {
  spans: readonly TrajectoryTimelineSpan[];
  turnBoundaries: readonly TrajectoryTimelineTurnBoundary[];
}

/**
 * Format a timeline duration as an integer-millisecond label.
 * @param milliseconds - Non-negative duration in milliseconds.
 * @returns Millisecond label with thousands separators.
 */
export function formatTimelineOffset(milliseconds: number): string {
  return formatDurationMillis(milliseconds);
}

function laneFor(kind: TrajectoryCellKind): number {
  if (kind === "tool" || kind === "subtool") return 2;
  if (kind === "message" || kind === "compacted") return 1;
  return 0;
}

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

/** The record's own duration in ms; null while in-flight or unknown. */
function ownDurationMs(cell: TrajectoryCellProps): number | null {
  return finite(cell.timeSeconds) ? Math.max(0, cell.timeSeconds * 1_000) : null;
}

function cellRange(cell: TrajectoryCellProps): TrajectoryTimeRange | null {
  if (!finite(cell.startedAt)) return null;
  const durationMs = finite(cell.timeSeconds) ? Math.max(0, cell.timeSeconds * 1_000) : 0;
  return { start: cell.startedAt, end: cell.startedAt + durationMs };
}

/**
 * Project every visible record into a stable three-lane timeline.
 * @param turns - Unfiltered trajectory layout.
 * @param mode - Independent equal/recorded duration and compressed/complete time projection.
 * @returns Timeline model, or `null` when no record is visible.
 */
export function deriveTrajectoryTimeline(
  turns: readonly TrajectoryTurnModel[],
  mode: TrajectoryTimelineMode = "sequence",
): TrajectoryTimelineModel | null {
  if (mode !== "sequence") {
    return deriveTimedTimeline(
      turns,
      mode === "duration" || mode === "actual",
      mode === "duration",
    );
  }
  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];

  for (const turn of turns) {
    const cells = turn.groups.flatMap((group) =>
      group.cells.filter((cell) => cell.requestOnly !== true),
    );
    if (cells.length === 0) continue;
    if (turn.turn !== null) {
      turnBoundaries.push({
        turn: turn.turn,
        time: spans.length,
      });
    }
    const base = spans.length;
    for (const [offset, cell] of cells.entries()) {
      const span: TrajectoryTimelineSpan = {
        start: base + offset,
        end: base + offset + 1,
        index: cell.index,
        durationMs: ownDurationMs(cell),
        isError: cell.isError === true,
        kind: cell.kind,
        label: cell.text,
        lane: laneFor(cell.kind),
      };
      if (cell.sourceSeq !== undefined) span.sourceSeq = cell.sourceSeq;
      spans.push(span);
    }
  }

  if (spans.length === 0) return null;
  return {
    start: 0,
    end: spans.length,
    spans,
    turnBoundaries,
  };
}

function deriveTimedTimeline(
  turns: readonly TrajectoryTurnModel[],
  actualDuration: boolean,
  compressIdle: boolean,
): TrajectoryTimelineModel | null {
  const timedTurns = turns.flatMap((turn) => {
    const rawSpans = turn.groups.flatMap((group) =>
      group.cells.flatMap((cell): TrajectoryTimelineSpan[] => {
        if (cell.requestOnly === true) return [];
        const range = cellRange(cell);
        return range === null
          ? []
          : [
              {
                ...range,
                index: cell.index,
                ...(cell.sourceSeq === undefined ? {} : { sourceSeq: cell.sourceSeq }),
                durationMs: ownDurationMs(cell),
                isError: cell.isError === true,
                kind: cell.kind,
                label: cell.text,
                lane: laneFor(cell.kind),
              },
            ];
      }),
    );
    return rawSpans.length === 0 ? [] : [{ turn: turn.turn, rawSpans }];
  });
  const rawSpans = timedTurns.flatMap((turn) => turn.rawSpans);
  if (rawSpans.length === 0) return null;

  const removedIdleBySpan = new Map<TrajectoryTimelineSpan, number>();
  let removedIdle = 0;
  let coveredUntil: number | null = null;
  for (const span of [...rawSpans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    if (compressIdle && coveredUntil !== null && span.start > coveredUntil) {
      removedIdle += span.start - coveredUntil;
    }
    removedIdleBySpan.set(span, removedIdle);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
  for (const turn of timedTurns) {
    const projected = turn.rawSpans.map((span): TrajectoryTimelineSpan => {
      const offset = removedIdleBySpan.get(span) ?? 0;
      return {
        ...span,
        start: span.start - offset,
        end: (actualDuration ? span.end : span.start) - offset,
      };
    });
    spans.push(...projected);
    if (turn.turn !== null) {
      turnBoundaries.push({
        turn: turn.turn,
        time: Math.min(...projected.map((span) => span.start)),
      });
    }
  }

  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
    spans,
    turnBoundaries,
  };
}

/**
 * Identify records active at any point inside an inclusive selected interval.
 * @param turns - Unfiltered trajectory layout.
 * @param range - Selected interval in the active projection.
 * @param mode - Independent equal/recorded duration and compressed/complete time projection.
 * @returns Record indexes inside the focus interval.
 */
export function trajectoryTimelineFocusIndexes(
  turns: readonly TrajectoryTurnModel[],
  range: TrajectoryTimeRange,
  mode: TrajectoryTimelineMode = "sequence",
): ReadonlySet<number> {
  const model = deriveTrajectoryTimeline(turns, mode);
  return new Set(
    model?.spans
      .filter((span) => span.start <= range.end && span.end >= range.start)
      .map((span) => span.index),
  );
}
