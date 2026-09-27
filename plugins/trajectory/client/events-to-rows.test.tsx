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
    expect(rows[0]).not.toHaveProperty("turnId");
    expect(rows[1]).toMatchObject({ kind: "tool", isError: true });
    expect(rows[1]).not.toHaveProperty("turnId");
  });
});
