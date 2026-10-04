/** Layout fold contracts over paseo ledger rows (dsh-retargeted).
 *
 * Derived from the DOM-free expectations of DeepSeek deepseek-harness
 * `tests/layout.client.spec.tsx` (commit afd92680f2, MIT — Copyright (c)
 * 2026 DeepSeek), re-expressed over our `TrajectoryFoldRow` input. Cases the
 * accepted T2.0 gap map drops (system-prompt snapshots, compaction requests,
 * sub-calls, partial streaming) have no equivalent input and no test here.
 */

import { describe, expect, it } from "vitest";
import {
  deriveTrajectoryLayout,
  type TrajectoryFoldRow,
  type TrajectoryTurnModel,
} from "./layout.ts";
import type { TrajectoryCellProps } from "./record.ts";

let seq = 0;
function row(
  overrides: Partial<TrajectoryFoldRow> & { kind: TrajectoryFoldRow["kind"] },
): TrajectoryFoldRow {
  seq += 1;
  return {
    seq,
    timeMs: Date.parse("2026-09-26T00:00:00Z") + seq * 1_000,
    label: "unknown",
    durationMs: null,
    turnId: "t1",
    step: null,
    ...overrides,
  };
}

/** Every cell across every turn; a module helper keeps the tests shallow. */
function allCellsOf(turns: readonly TrajectoryTurnModel[]): TrajectoryCellProps[] {
  return turns.flatMap((turn) => turn.groups.flatMap((group) => [...group.cells]));
}

function derivedRows(): TrajectoryFoldRow[] {
  const rows: TrajectoryFoldRow[] = [
    {
      seq: 1,
      timeMs: null,
      kind: "systemPrompt",
      label: "system prompt · 1,234 chars · hash abcdef123456…",
      durationMs: null,
      turnId: null,
      step: null,
      derived: true,
    },
    {
      seq: 2,
      timeMs: null,
      kind: "user",
      label: "user message (4 chars)",
      durationMs: null,
      turnId: "t1",
      step: null,
    },
    {
      seq: 3,
      timeMs: null,
      kind: "llm",
      label: "llm round 1 · consumed 2 results",
      durationMs: null,
      turnId: "t1",
      step: null,
      derived: true,
    },
  ];
  return rows;
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

  // --- own duration at the fold, per kind (T15) ---------------------------

  it("gives an OBSERVED reasoning run its measured span, unlike a derived row", () => {
    // Reasoning streams like a message does, so the fold measured a span for it.
    // Reading it as a derived boundary is what left reasoning rows with no
    // running time while every other streamed row had one.
    const turns = deriveTrajectoryLayout({
      rows: [
        row({
          kind: "thinking",
          turnId: "t1",
          step: 1,
          label: "reasoning · 1,200 chars total",
          durationMs: 3_400,
        }),
      ],
    });
    const thinking = turns[0].groups[0].cells[0];
    expect(thinking.kind).toBe("thinking");
    expect(thinking.timeSeconds).toBeCloseTo(3.4, 5);
  });

  it("gives a derived row no duration even when it carries one", () => {
    const turns = deriveTrajectoryLayout({
      rows: [
        row({
          kind: "llm",
          turnId: "t1",
          label: "llm round 1 · consumed 2 results",
          durationMs: 900,
          derived: true,
        }),
      ],
    });
    expect(turns[0].groups[0].cells[0].timeSeconds).toBeNull();
  });

  it("reports a recorded duration even when the row has no absolute stamp", () => {
    // The recorder measured the span on its own clock; losing the start does not
    // unmeasure it, and the detail panel reads the same fact from the row.
    const turns = deriveTrajectoryLayout({
      rows: [
        row({
          kind: "tool",
          turnId: "t1",
          step: 1,
          label: "shell",
          callId: "c1",
          timeMs: null,
          durationMs: 2_400,
        }),
      ],
    });
    const tool = turns[0].groups[0].cells[0];
    expect(tool.timeSeconds).toBeCloseTo(2.4, 5);
    expect(tool.startedAt).toBeNull();
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

  // --- T3-D: derived round + system-prompt rows ---------------------------

  it("renders a derived round as its own llm cell inside its turn", () => {
    const turns = deriveTrajectoryLayout({ rows: derivedRows() });
    const t1 = turns.find((turn) => turn.turn === 1);
    expect(t1).toBeDefined();
    const cells = t1 === undefined ? [] : allCellsOf([t1]);
    const llm = cells.find((cell) => cell.kind === "llm");
    expect(llm?.text).toBe("llm round 1 · consumed 2 results");
    expect(llm?.timeSeconds).toBeNull();
  });

  it("puts a turn-less system prompt in an unnumbered bucket that precedes Turn 1", () => {
    const turns = deriveTrajectoryLayout({ rows: derivedRows() });
    // The prompt row has turnId=null, so it cannot join a numbered turn. It
    // lands in its own bucket, ordered first by cell index.
    expect(turns[0]?.turn).toBeNull();
    const preamble = turns[0] === undefined ? [] : allCellsOf([turns[0]]);
    expect(preamble.map((cell) => cell.kind)).toEqual(["systemPrompt"]);
    expect(preamble[0]?.text).toBe("system prompt · 1,234 chars · hash abcdef123456…");
    // And the real turn is still numbered 1, not pushed down by the preamble.
    expect(turns.some((turn) => turn.turn === 1)).toBe(true);
  });

  it("drops no rows: every derived row reaches some cell", () => {
    const cells = allCellsOf(deriveTrajectoryLayout({ rows: derivedRows() }));
    expect(cells.map((cell) => cell.kind).sort()).toEqual(["llm", "systemPrompt", "user"]);
  });
});
