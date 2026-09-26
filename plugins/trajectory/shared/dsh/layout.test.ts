/** Layout fold contracts over paseo ledger rows (dsh-retargeted).
 *
 * Derived from the DOM-free expectations of DeepSeek deepseek-harness
 * `tests/layout.client.spec.tsx` (commit afd92680f2, MIT — Copyright (c)
 * 2026 DeepSeek), re-expressed over our `TrajectoryFoldRow` input. Cases the
 * accepted T2.0 gap map drops (system-prompt snapshots, compaction requests,
 * sub-calls, partial streaming) have no equivalent input and no test here.
 */

import { describe, expect, it } from "vitest";
import { deriveTrajectoryLayout, type TrajectoryFoldRow } from "./layout.ts";

let seq = 0;
function row(
  overrides: Partial<TrajectoryFoldRow> & { kind: TrajectoryFoldRow["kind"] },
): TrajectoryFoldRow {
  seq += 1;
  return {
    seq,
    timeMs: Date.parse("2026-09-26T00:00:00Z") + seq * 1_000,
    kind: overrides.kind,
    label: "unknown",
    durationMs: null,
    turnId: "t1",
    step: null,
    ...overrides,
  };
}

describe("deriveTrajectoryLayout (ledger rows)", () => {
  it("folds a turn into Message (user) + Step groups with usage on the message", () => {
    const rows = [
      row({ kind: "user", turnId: "t1", label: "user message (5 chars)" }),
      row({
        kind: "message",
        turnId: "t1",
        step: 1,
        label: "assistant message (100 chars)",
        durationMs: 1_000,
        usage: { input: 10, cacheRead: null, cacheWrite: null, output: 5, think: null },
      }),
      row({
        kind: "tool",
        turnId: "t1",
        step: 1,
        label: "shell · npm test",
        callId: "c1",
        durationMs: 1_500,
      }),
    ];
    const turns = deriveTrajectoryLayout({ rows });
    expect(turns).toHaveLength(1);
    const turn = turns[0];
    expect(turn.turn).toBe(1);
    expect(turn.groups.map((group) => group.title)).toEqual(["Message", "Step 1"]);
    expect(turn.groups[0].cells[0].kind).toBe("user");
    expect(turn.groups[0].cells[0].opensTurn).toBe(true);
    const message = turn.groups[1].cells[0];
    expect(message.kind).toBe("message");
    expect(message.input).toBe(10);
    expect(message.output).toBe(5);
    // Own duration: 1s gap between message and next row stamps.
    expect(message.timeSeconds).toBeCloseTo(1, 5);
    const tool = turn.groups[1].cells[1];
    expect(tool.kind).toBe("tool");
    expect(tool.text).toBe("shell");
    expect(tool.previewMarkdown).toBe("npm test");
    expect(tool.timeSeconds).toBeCloseTo(1.5, 5);
    expect(turn.usage).toEqual({ input: 10, output: 5 });
  });

  it("renders in-flight tool rows with null duration (em dash upstream)", () => {
    const rows = [
      row({
        kind: "tool",
        turnId: "t1",
        step: 1,
        label: "fetch",
        callId: "c9",
        durationMs: null,
      }),
    ];
    const turns = deriveTrajectoryLayout({ rows, openCallIds: new Set(["c9"]) });
    const tool = turns[0].groups[0].cells[0];
    expect(tool.timeSeconds).toBeNull();
    expect(tool.callId).toBe("c9");
  });

  it("numbers turns by first appearance and orders output by first cell", () => {
    const rows = [
      row({ kind: "message", turnId: "t2", step: 1, label: "a" }),
      row({ kind: "user", turnId: "t1", label: "early user" }),
      row({ kind: "message", turnId: "t1", step: 1, label: "b" }),
    ];
    const turns = deriveTrajectoryLayout({ rows });
    expect(turns.map((turn) => turn.turn)).toEqual([1, 2]);
  });

  it("sums disjoint token buckets across the turn", () => {
    const rows = [
      row({
        kind: "message",
        turnId: "t1",
        step: 1,
        usage: { input: 10, cacheRead: 2, cacheWrite: null, output: 5, think: 1 },
      }),
      row({
        kind: "message",
        turnId: "t1",
        step: 2,
        usage: { input: 7, cacheRead: null, cacheWrite: 3, output: 8, think: null },
      }),
    ];
    const turns = deriveTrajectoryLayout({ rows });
    expect(turns[0].usage).toEqual({
      input: 17,
      cacheRead: 2,
      cacheWrite: 3,
      output: 13,
      think: 1,
    });
  });

  it("empty input folds to no turns", () => {
    expect(deriveTrajectoryLayout({ rows: [] })).toEqual([]);
  });
});
