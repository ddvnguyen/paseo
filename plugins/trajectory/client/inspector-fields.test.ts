/** The detail view's field values: dsh's vocabulary, our ledger's facts. */

import { describe, expect, it } from "vitest";
import type { TrajectoryFoldRow } from "../shared/dsh/layout.js";
import {
  formatDurationMs,
  formatStartedAt,
  formatUnixSeconds,
  generationTime,
  recordStatus,
  statusLabel,
  throughput,
  timeToFirstToken,
  timingSource,
  tokenSplit,
  toolArgs,
  totalDuration,
} from "./inspector-fields.js";

const T0 = Date.parse("2026-10-03T00:00:00Z");

function row(overrides: Partial<TrajectoryFoldRow> = {}): TrajectoryFoldRow {
  return {
    seq: 7,
    timeMs: T0,
    kind: "tool",
    label: "shell · npm test",
    durationMs: 2_400,
    turnId: "t1",
    step: null,
    ...overrides,
  };
}

function message(overrides: Partial<TrajectoryFoldRow> = {}): TrajectoryFoldRow {
  return row({ kind: "message", label: "assistant message (84 chars)", step: 1, ...overrides });
}

describe("record status", () => {
  it("reads Completed / Pending / Failed the way dsh labels them", () => {
    expect(statusLabel(recordStatus(row()))).toBe("Completed");
    // A call with no result yet is the one state that is still running.
    expect(statusLabel(recordStatus(row({ open: true, durationMs: null })))).toBe("Pending");
    expect(statusLabel(recordStatus(row({ isError: true })))).toBe("Failed");
    // Failure wins over pending: a recorded failure is settled, not in flight.
    expect(statusLabel(recordStatus(row({ isError: true, open: true })))).toBe("Failed");
  });
});

describe("timing panel", () => {
  it("reports a measured total from the row's own stamps", () => {
    // 2400ms -> "2.40 s": two decimals under ten seconds, as dsh formats it.
    expect(totalDuration(row())).toBe("2.40 s");
    expect(formatDurationMs(999)).toBe("999 ms");
    expect(formatDurationMs(12_300)).toBe("12.3 s");
  });

  it("says why a total is missing instead of showing nothing", () => {
    expect(totalDuration(row({ durationMs: null }))).toBe("Not recorded");
    // A row whose absolute stamp went missing still has a measured span: the
    // recorder's own call->result clock produced it, and losing the start does
    // not unmeasure it.
    expect(totalDuration(row({ timeMs: null }))).toBe("2.40 s");
  });

  it("names the unmeasured assistant metrics rather than inventing them", () => {
    const measured = message();
    expect(timeToFirstToken(measured)).toBe("First token unavailable");
    expect(generationTime(measured)).toBe("First token unavailable");
    // No usage at all is a different gap from no first token, and says so.
    expect(throughput(measured)).toBe("Usage unavailable");
    expect(throughput(message({ usage: usage({ output: 84 }) }))).toBe("First token unavailable");
    expect(throughput(message({ usage: usage({ output: null }) }))).toBe(
      "Output tokens unavailable",
    );
    // With neither timing nor usage, timing is the first missing fact.
    expect(timeToFirstToken(message({ durationMs: null }))).toBe("Not recorded");
  });

  it("states where a row's duration came from", () => {
    // A tool span is the recorder's own call->result clock, not two ledger
    // stamps; a message span really is two ledger stamps. Saying "session
    // timestamps" for both would be dsh's answer, and wrong for ours.
    expect(timingSource(row())).toBe("Recorder clock (call → result)");
    expect(timingSource(message())).toBe("Ledger timestamps");
    expect(timingSource(row({ durationMs: null }))).toBe("Not available");
    expect(timingSource(row({ open: true, durationMs: null }))).toBe("Recorder clock (running)");
  });
});

describe("token split", () => {
  it("splits output into its reasoning and content shares", () => {
    expect(tokenSplit(message({ usage: usage({ input: 1_200, output: 84, think: 12 }) }))).toEqual([
      { label: "output", value: "84 tok" },
      { label: "reasoning", value: "12 tok" },
      { label: "content", value: "72 tok" },
    ]);
  });

  it("omits a share the provider did not report, rather than subtracting it", () => {
    // No reasoning bucket means no content split: 84 - unknown is not a number.
    expect(
      tokenSplit(message({ usage: usage({ input: 1_200, output: 84, think: null }) })),
    ).toEqual([{ label: "output", value: "84 tok" }]);
    expect(tokenSplit(message())).toEqual([]);
  });

  it("never reports a negative content count", () => {
    expect(tokenSplit(message({ usage: usage({ output: 10, think: 40 }) }))).toEqual([
      { label: "output", value: "10 tok" },
      { label: "reasoning", value: "40 tok" },
      { label: "content", value: "0 tok" },
    ]);
  });
});

describe("tool payload", () => {
  it("reads the recorded arguments back out of the row label", () => {
    expect(toolArgs("shell · npm test")).toBe("npm test");
    expect(toolArgs("read · src/app.ts")).toBe("src/app.ts");
  });

  it("reports no payload for a call recorded without arguments", () => {
    expect(toolArgs("shell")).toBeNull();
    expect(toolArgs("shell · ")).toBeNull();
  });
});

describe("started stamp", () => {
  it("renders a local wall clock with milliseconds", () => {
    const epochMs = new Date(2026, 9, 3, 14, 5, 6, 78).getTime();
    expect(formatStartedAt(epochMs)).toBe("2026-10-03 14:05:06.078");
  });

  it("offers the same instant as unix seconds", () => {
    const epochMs = Date.parse("2026-10-03T00:00:00.250Z");
    expect(formatUnixSeconds(epochMs)).toBe((epochMs / 1_000).toFixed(3));
  });

  it("says so when the row has no usable stamp", () => {
    expect(formatStartedAt(null)).toBe("Not available");
    expect(formatUnixSeconds(null)).toBe("Not available");
    expect(formatStartedAt(Number.NaN)).toBe("Not available");
  });
});

function usage(overrides: {
  input?: number | null;
  output?: number | null;
  think?: number | null;
}): TrajectoryFoldRow["usage"] {
  return {
    input: overrides.input ?? null,
    cacheRead: null,
    cacheWrite: null,
    output: overrides.output ?? null,
    think: overrides.think ?? null,
  };
}
