import type { TrajectoryFoldRow } from "../shared/dsh/layout.js";

/**
 * The detail view's field values, ported from dsh's details panel.
 *
 * Source: `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx` in
 * deepseek-harness @ `afd92680f2` (MIT) — `stateOf`/`statusLabel` (669-683),
 * `totalTime`/`ttft`/`generationTime`/`throughput` (304-332), `TokenRows`
 * (685-709) and `RecordTiming` (1452-1462).
 *
 * Kept as pure functions over our ledger row rather than a cell: the inspector
 * is handed the `TrajectoryFoldRow` the ledger selected, and these are the only
 * places that decide what a row's own numbers SAY. Every value dsh renders as a
 * reason rather than a number ("Not recorded", "First token unavailable") is
 * reproduced verbatim, because that wording is the point: a reader learns the
 * gap instead of seeing an empty field and guessing.
 */

/** dsh's `RecordState`. */
export type RecordStatus = "complete" | "running" | "error";

/**
 * A row's status, from what we actually observed.
 *
 * dsh derives `running` from a tool cell with no captured output. Our ledger
 * records the same fact directly: the recorder wrote the call and no result has
 * arrived, which the fold marks `open`. Anything else that reached the ledger
 * completed, whatever it was.
 */
export function recordStatus(row: TrajectoryFoldRow): RecordStatus {
  if (row.isError === true) return "error";
  if (row.open === true) return "running";
  return "complete";
}

/** dsh's `statusLabel`: Failed / Pending / Completed. */
export function statusLabel(status: RecordStatus): string {
  if (status === "error") return "Failed";
  if (status === "running") return "Pending";
  return "Completed";
}

/**
 * The assistant timing facts, from the row's own stamps.
 *
 * `firstTokenTime` is null for every row we record, and that is the honest
 * ceiling: no provider event tells us when the first token of a response
 * arrived, so TTFT and everything derived from it (generation window,
 * decode throughput) have no denominator. dsh has both because its harness
 * instruments the request; we say which field is missing instead of
 * substituting a number.
 */
function assistantMetrics(row: TrajectoryFoldRow): {
  timingRecorded: boolean;
  stepStartTime: number | null;
  firstTokenTime: null;
  completedTime: number | null;
  usageProvided: boolean;
  outputTokens: number | null;
} {
  return {
    timingRecorded: row.durationMs !== null,
    stepStartTime: row.timeMs,
    firstTokenTime: null,
    completedTime:
      row.durationMs === null || row.timeMs === null ? null : row.timeMs + row.durationMs,
    usageProvided: row.usage !== undefined,
    outputTokens: row.usage?.output ?? null,
  };
}

/**
 * dsh's ms formatter, used ONLY by the timing panel.
 *
 * Distinct from the ledger's own duration tiers (`formatDurationMillis`), which
 * floor to keep a narrow column scannable: this one keeps two decimals so a
 * sub-second TTFT is legible as a measurement rather than rounded to "0 ms".
 */
export function formatDurationMs(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

/**
 * dsh's `totalTime`: the row's own span, or why there is none.
 *
 * dsh arrives at this by subtracting the step start from the completion stamp,
 * because its cells carry no duration of their own. Ours does: the fold measured
 * it, so it is read directly. That also keeps a duration visible when the
 * absolute stamp went missing — the recorder's own clock produced the span, and
 * losing the start does not unmeasure it.
 */
export function totalDuration(row: TrajectoryFoldRow): string {
  if (row.durationMs === null) return "Not recorded";
  return formatDurationMs(Math.max(0, row.durationMs));
}

/** dsh's `ttft`. Always unmeasured for us; the reason is the value. */
export function timeToFirstToken(row: TrajectoryFoldRow): string {
  const metrics = assistantMetrics(row);
  if (!metrics.timingRecorded) return "Not recorded";
  if (metrics.stepStartTime === null) return "Step start unavailable";
  if (metrics.firstTokenTime === null) return "First token unavailable";
  return formatDurationMs(Math.max(0, metrics.firstTokenTime - metrics.stepStartTime));
}

/** dsh's `generationTime`: the decode window, which needs a first token. */
export function generationTime(row: TrajectoryFoldRow): string {
  const metrics = assistantMetrics(row);
  if (!metrics.timingRecorded || metrics.firstTokenTime === null) {
    return "First token unavailable";
  }
  if (metrics.completedTime === null) return "Pending";
  return formatDurationMs(Math.max(0, metrics.completedTime - metrics.firstTokenTime));
}

/** dsh's `throughput`: output tokens per second of generation. */
export function throughput(row: TrajectoryFoldRow): string {
  const metrics = assistantMetrics(row);
  if (!metrics.usageProvided) return "Usage unavailable";
  if (metrics.outputTokens === null) return "Output tokens unavailable";
  if (!metrics.timingRecorded || metrics.firstTokenTime === null) {
    return "First token unavailable";
  }
  if (metrics.completedTime === null) return "Pending";
  const generationSeconds = (metrics.completedTime - metrics.firstTokenTime) / 1_000;
  if (generationSeconds <= 0) return "Duration too short";
  return `${(metrics.outputTokens / generationSeconds).toFixed(1)} tok/s`;
}

/**
 * Where a row's duration came from — dsh's third Timing line.
 *
 * One reader-facing distinction: a duration the recorder measured from its own
 * call→result clock, or no measurement at all. An OPEN row is "still running",
 * which is a third state and not the same as having no measurement.
 */
export function timingSource(row: TrajectoryFoldRow): string {
  if (row.open === true) return "Ledger timestamps (running)";
  if (row.durationMs === null) return "Not available";
  return "Ledger timestamps";
}

/** One dsh-shaped token line: a label and a value already formatted. */
export interface TokenLine {
  label: string;
  value: string;
}

/**
 * dsh's `TokenRows`: completion tokens, the reasoning share of them, and the
 * content left over. dsh renders the reasoning and content rows only when the
 * provider reported them, and so does this — an unreported split would be a
 * subtraction that invents a number.
 */
export function tokenSplit(row: TrajectoryFoldRow): TokenLine[] {
  const usage = row.usage;
  if (usage === undefined) return [];
  const lines: TokenLine[] = [];
  if (usage.output !== null) lines.push({ label: "output", value: `${count(usage.output)} tok` });
  if (usage.think !== null) lines.push({ label: "reasoning", value: `${count(usage.think)} tok` });
  if (usage.output !== null && usage.think !== null) {
    lines.push({
      label: "content",
      value: `${count(Math.max(0, usage.output - usage.think))} tok`,
    });
  }
  return lines;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * The tool arguments a row recorded, or null when it recorded none.
 *
 * The fold stores the call as `name · args`, so the payload half is read back
 * out of that label rather than stored twice. This is dsh's Payload tab for the
 * one field we observe: the arguments as a one-line summary. The RESULT text is
 * not in the ledger at all (length only, by the privacy decision d-893c722f28),
 * so the panel states that instead of showing an empty tab.
 */
export function toolArgs(label: string): string | null {
  const separator = label.indexOf(" · ");
  if (separator === -1) return null;
  const args = label.slice(separator + 3).trim();
  return args === "" ? null : args;
}

/**
 * dsh's timestamp toggle: local wall clock by default, unix seconds on demand.
 *
 * A ledger is read across machines — the daemon stamped the event, this device
 * is showing it — and the two views answer different questions ("when did that
 * happen here" vs "which event is this in the log"), so both are one press away.
 */
export function formatStartedAt(epochMs: number | null): string {
  if (epochMs === null || !Number.isFinite(epochMs)) return "Not available";
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return "Not available";
  const two = (value: number): string => String(value).padStart(2, "0");
  const three = (value: number): string => String(value).padStart(3, "0");
  const time = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(
    date.getMilliseconds(),
  )}`;
  const day = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  return `${day} ${time}`;
}

/** Unix seconds with milliseconds, dsh's alternate stamp. */
export function formatUnixSeconds(epochMs: number | null): string {
  if (epochMs === null || !Number.isFinite(epochMs)) return "Not available";
  return (epochMs / 1_000).toFixed(3);
}
