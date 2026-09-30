/** Adapter spec: ledger events -> fold rows (T2.4 read path). */

import { describe, expect, it } from "vitest";
import type { TrajectoryEvent } from "../shared/trajectory.js";
import { eventsToFoldRows } from "./events-to-rows.js";

const T0 = Date.parse("2026-09-27T00:00:00Z");

function event(
  overrides: Partial<TrajectoryEvent> & Pick<TrajectoryEvent, "seq" | "type">,
): TrajectoryEvent {
  return {
    time: new Date(T0 + overrides.seq * 1_000).toISOString(),
    turn: "t1",
    step: null,
    agentId: "a1",
    data: {},
    ...overrides,
  };
}

describe("eventsToFoldRows", () => {
  it("pairs tool call/result rows and keeps unmatched calls in-flight", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "tool/call",
        data: { callId: "c1", name: "shell", argSummary: "npm test" },
      }),
      event({
        seq: 2,
        type: "tool/result",
        data: { callId: "c1", name: "shell", outputChars: 1520, isError: false, durationMs: 2_400 },
      }),
      event({ seq: 3, type: "tool/call", data: { callId: "c2", name: "edit" } }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "tool",
      label: "shell · npm test",
      durationMs: 2_400,
      callId: "c1",
      outputChars: 1520,
    });
    // Unmatched call stays in-flight: null duration renders the em dash.
    expect(rows[1]).toMatchObject({ kind: "tool", label: "edit", durationMs: null, callId: "c2" });
  });

  it("attaches turn/end usage buckets to the turn's last message row", () => {
    const rows = eventsToFoldRows([
      event({ seq: 1, type: "user/message", data: { textLength: 12 } }),
      event({ seq: 2, type: "assistant/message", step: 1, data: { textLength: 84 } }),
      event({ seq: 3, type: "assistant/message", step: 2, data: { textLength: 212 } }),
      event({
        seq: 4,
        type: "turn/end",
        data: {
          usage: {
            inputTokens: 1_234,
            outputTokens: 89,
            cachedInputTokens: 567,
            reasoningTokens: null,
          },
        },
      }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: "user", label: "user message (12 chars)" });
    expect(rows[1]?.usage).toBeUndefined();
    expect(rows[2]?.usage).toEqual({
      input: 1_234,
      cacheRead: 567,
      cacheWrite: null,
      output: 89,
      think: null,
    });
  });

  it("drops failed-tool flags through and renders null-turn rows", () => {
    const rows = eventsToFoldRows([
      event({ seq: 1, type: "user/message", turn: null, data: { textLength: 5 } }),
      event({
        seq: 2,
        type: "tool/result",
        turn: null,
        data: { callId: "c9", name: "read", isError: true },
      }),
    ]);
    expect(rows[0]).toMatchObject({ kind: "user", label: "user message (5 chars)" });
    // A row with no turn is null, not absent: TrajectoryFoldRow.turnId is a
    // required nullable field, and layout.ts folds null-turn rows into the
    // enclosing turn. The old conditional spread emitted `undefined` here, which
    // is what failed the plugin typecheck.
    expect(rows[0].turnId).toBeNull();
    expect(rows[1]).toMatchObject({ kind: "tool", isError: true });
    expect(rows[1].turnId).toBeNull();
  });
  it("carries the source message id through to the fold row", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "user/message",
        turn: "t1",
        data: { textLength: 18, sourceMessageId: "m-1" },
      }),
    ]);
    expect(rows[0].sourceMessageId).toBe("m-1");
  });

  it("leaves the identity absent for a row recorded without one", () => {
    // Old rows have no id in their data blob; they must keep the length label.
    const rows = eventsToFoldRows([
      event({ seq: 1, type: "user/message", turn: "t1", data: { textLength: 18 } }),
    ]);
    expect(rows[0].sourceMessageId).toBeUndefined();
  });

  it("ignores a non-string or empty identity in the data blob", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "user/message",
        turn: "t1",
        data: { textLength: 1, sourceMessageId: 42 },
      }),
    ]);
    expect(rows[0].sourceMessageId).toBeUndefined();

    const empty = eventsToFoldRows([
      event({
        seq: 2,
        type: "user/message",
        turn: "t1",
        data: { textLength: 1, sourceMessageId: "" },
      }),
    ]);
    expect(empty[0].sourceMessageId).toBeUndefined();
  });

  // --- T3-B: per-row message delta ---------------------------------------
  //
  // The daemon re-emits one assistant message on every stream chunk with the
  // same sourceMessageId and a growing textLength. Each row must therefore
  // carry only what it added, never the cumulative total.

  it("reports each assistant chunk as its own delta of the message total", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "assistant/message",
        data: { sourceMessageId: "m-1", textLength: 1 },
      }),
      event({
        seq: 2,
        type: "assistant/message",
        data: { sourceMessageId: "m-1", textLength: 68 },
      }),
      event({
        seq: 3,
        type: "assistant/message",
        data: { sourceMessageId: "m-1", textLength: 90 },
      }),
    ]);
    expect(rows.map((row) => row.deltaChars)).toEqual([1, 67, 22]);
    // The cumulative total travels alongside so the slice offset is derivable.
    expect(rows.map((row) => row.textLength)).toEqual([1, 68, 90]);
    expect(rows.map((row) => row.deltaStart)).toEqual([0, 1, 68]);
  });

  it("keeps the deltas of two interleaved messages separate", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "assistant/message",
        data: { sourceMessageId: "m-1", textLength: 10 },
      }),
      event({ seq: 2, type: "assistant/message", data: { sourceMessageId: "m-2", textLength: 5 } }),
      event({
        seq: 3,
        type: "assistant/message",
        data: { sourceMessageId: "m-1", textLength: 14 },
      }),
      event({ seq: 4, type: "assistant/message", data: { sourceMessageId: "m-2", textLength: 6 } }),
    ]);
    expect(rows.map((row) => row.deltaChars)).toEqual([10, 5, 4, 1]);
  });

  it("reports no delta when the message carries no source identity", () => {
    const rows = eventsToFoldRows([
      event({ seq: 1, type: "assistant/message", data: { textLength: 40 } }),
    ]);
    expect(rows[0].deltaChars).toBeUndefined();
    expect(rows[0].textLength).toBeUndefined();
    // The length label still stands, so the row is not blank.
    expect(rows[0].label).toBe("assistant message (40 chars)");
  });

  it("reports no delta when the length is unknown", () => {
    const rows = eventsToFoldRows([
      event({ seq: 1, type: "assistant/message", data: { sourceMessageId: "m-1" } }),
    ]);
    expect(rows[0].deltaChars).toBeUndefined();
  });

  it("refuses a negative delta when a producer's total shrinks mid-message", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "assistant/message",
        data: { sourceMessageId: "m-1", textLength: 50 },
      }),
      event({ seq: 2, type: "assistant/message", data: { sourceMessageId: "m-1", textLength: 5 } }),
    ]);
    expect(rows[0].deltaChars).toBe(50);
    // A shrinking total means the stream restarted; report nothing rather than
    // a negative size, and let the label stand.
    expect(rows[1].deltaChars).toBeUndefined();
  });

  it("gives a user row its prompt length with no delta", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "user/message",
        data: { sourceMessageId: "u-1", textLength: 18 },
      }),
    ]);
    expect(rows[0].kind).toBe("user");
    expect(rows[0].textLength).toBe(18);
    expect(rows[0].deltaChars).toBeUndefined();
  });
});
