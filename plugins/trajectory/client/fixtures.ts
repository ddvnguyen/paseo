import type { TrajectoryFoldRow } from "../shared/dsh/layout.js";

/**
 * Static ledger fixtures. The component renders without a daemon: tests
 * (wide + compact) and T2.4's live-data wiring both feed the same shape.
 * Times are real epoch ms so own-duration folding is exact.
 */

const BASE = Date.parse("2026-09-26T00:00:00Z");

function row(
  offsetSeconds: number,
  overrides: Partial<TrajectoryFoldRow> & Pick<TrajectoryFoldRow, "kind">,
): TrajectoryFoldRow {
  return {
    seq: offsetSeconds,
    timeMs: BASE + offsetSeconds * 1_000,
    label: "unknown",
    durationMs: null,
    turnId: "t1",
    step: null,
    ...overrides,
  };
}

export const FIXTURE_ROWS: readonly TrajectoryFoldRow[] = [
  // Turn 1: user prompt, assistant step with two tools (one failed), second step.
  row(0, { kind: "user", turnId: "t1", label: "run the test suite" }),
  row(1, {
    kind: "message",
    turnId: "t1",
    step: 1,
    label: "assistant message (84 chars)",
    durationMs: 1_200,
  }),
  row(2, {
    kind: "tool",
    turnId: "t1",
    step: 1,
    label: "shell · npm test",
    callId: "c1",
    durationMs: 2_400,
    outputChars: 1520,
  }),
  row(3, {
    kind: "tool",
    turnId: "t1",
    step: 1,
    label: "read · src/app.ts",
    callId: "c2",
    durationMs: 300,
    isError: true,
    outputChars: 0,
  }),
  row(4, {
    kind: "message",
    turnId: "t1",
    step: 2,
    label: "assistant message (212 chars)",
    durationMs: 900,
  }),
  // Turn 2: user prompt, assistant step with an in-flight tool (em dash).
  row(30, { kind: "user", turnId: "t2", label: "fix the failing assertion" }),
  row(31, {
    kind: "message",
    turnId: "t2",
    step: 1,
    label: "assistant message (56 chars)",
    durationMs: 700,
  }),
  row(32, {
    kind: "tool",
    turnId: "t2",
    step: 1,
    label: "edit · src/app.ts",
    callId: "c3",
    durationMs: null,
  }),
];

export const FIXTURE_OPEN_CALLS: ReadonlySet<string> = new Set(["c3"]);

export const FIXTURE_TURN_NUMBERS: ReadonlyMap<string, number> = new Map([
  ["t1", 1],
  ["t2", 2],
]);
