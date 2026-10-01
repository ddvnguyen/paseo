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
    // The two assistant messages are one response and merge, so the turn holds
    // a user row plus a single merged message row.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "user", label: "user message (12 chars)" });
    expect(rows[1]?.usage).toEqual({
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

  it("merges a streamed response into one row carrying the total length", () => {
    // The daemon re-emits one assistant message on every stream chunk. These
    // three rows are ONE response and must render as one row (owner item 11).
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
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("message");
    expect(rows[0]?.textLength).toBe(90);
    expect(rows[0]?.segments).toBe(3);
    expect(rows[0]?.sourceMessageIds).toEqual(["m-1"]);
    // The stable selection identity is the FIRST segment's seq.
    expect(rows[0]?.seq).toBe(1);
    expect(rows[0]?.sourceMessageId).toBe("m-1");
  });

  it("merges a zero-delta re-emission into the run instead of showing +0", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "assistant/message",
        data: { sourceMessageId: "m-1", textLength: 40 },
      }),
      // Same cumulative length: this chunk added nothing.
      event({
        seq: 2,
        type: "assistant/message",
        data: { sourceMessageId: "m-1", textLength: 40 },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.segments).toBe(2);
    expect(rows[0]?.textLength).toBe(40);
  });

  it("keeps a merge inside one turn and splits it across a tool row", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "assistant/message",
        data: { sourceMessageId: "m-1", textLength: 10 },
      }),
      event({
        seq: 2,
        type: "assistant/message",
        data: { sourceMessageId: "m-1", textLength: 20 },
      }),
      event({
        seq: 3,
        type: "tool/result",
        data: { callId: "c1", name: "shell", outputChars: 2, isError: false, durationMs: 5 },
      }),
      event({ seq: 4, type: "assistant/message", data: { sourceMessageId: "m-2", textLength: 7 } }),
    ]);
    const messages = rows.filter((row) => row.kind === "message");
    expect(messages).toHaveLength(2);
    // The tool call is exactly where the model did something new, so it ends
    // the run even though both message rows share a turn.
    expect(messages[0]?.segments).toBe(2);
    expect(messages[1]?.segments).toBe(1);
    expect(messages[1]?.sourceMessageIds).toEqual(["m-2"]);
  });

  it("starts a new row when the source message id changes", () => {
    // A run is one agent response, and the source message id IS the response.
    // QC r20: merging on turn welded a reused-turn-id response onto the previous
    // one, so the newest response never became a row of its own.
    const rows = eventsToFoldRows([
      event({ seq: 1, type: "assistant/message", data: { sourceMessageId: "m-1", textLength: 4 } }),
      event({ seq: 2, type: "assistant/message", data: { sourceMessageId: "m-2", textLength: 6 } }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sourceMessageIds)).toEqual([["m-1"], ["m-2"]]);
  });

  it("splits an interleaved stream per source id rather than welding it", () => {
    // Each id is its own response, so an interleaved stream is several responses.
    // Before this rule the whole thing collapsed into one row whose identity the
    // previous response already held.
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
    const messages = rows.filter((row) => row.kind === "message");
    expect(messages).toHaveLength(4);
    expect(messages.map((row) => row.sourceMessageIds?.[0])).toEqual(["m-1", "m-2", "m-1", "m-2"]);
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
    // The run still merges, and keeps the FIRST segment's honest delta: a
    // shrinking total means the stream restarted, and nothing negative is
    // invented for it.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deltaChars).toBe(50);
    expect(rows[0]?.segments).toBe(2);
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

  // --- T3-D: derived round + system-prompt rows ---------------------------

  it("turns a derived round event into an llm row stating the claim", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "round/begin",
        turn: "t1",
        data: { derived: true, ordinal: 2, consumedResults: 3 },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("llm");
    expect(rows[0].label).toBe("llm round 2 · consumed 3 results");
    expect(rows[0].derived).toBe(true);
    expect(rows[0].durationMs).toBeNull();
  });

  it("says so plainly when a round has no ordinal or no results", () => {
    const rows = eventsToFoldRows([event({ seq: 1, type: "round/begin", turn: "t1", data: {} })]);
    expect(rows[0].label).toBe("llm round · consumed 0 results");
    expect(rows[0].derived).toBeUndefined();
  });

  it("turns a system/attach event into a size-and-hash row with no turn", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "system/attach",
        turn: null,
        data: { derived: true, charsLength: 1234, hash12: "abcdef123456" },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("systemPrompt");
    expect(rows[0].label).toBe("system prompt · 1,234 chars · hash abcdef123456…");
    expect(rows[0].turnId).toBeNull();
    expect(rows[0].derived).toBe(true);
  });

  it("reports an unknown prompt size as an em dash rather than zero", () => {
    const rows = eventsToFoldRows([
      event({ seq: 1, type: "system/attach", turn: null, data: { hash12: "abc" } }),
    ]);
    expect(rows[0].label).toBe("system prompt · — chars · hash abc…");
  });

  it("labels the daemon's appended instructions as their own row, same shape", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "system/attach",
        turn: null,
        data: {
          derived: true,
          source: "daemon-append",
          correlated: "time-window",
          charsLength: 412,
          hash12: "998877665544",
        },
      }),
    ]);
    // Identical kind, palette and turn handling to a caller prompt — both are
    // context in force before the first turn. Only the label says which.
    expect(rows[0].kind).toBe("systemPrompt");
    expect(rows[0].label).toBe("daemon instructions · 412 chars · hash 998877665544…");
    expect(rows[0].turnId).toBeNull();
  });

  it("keeps reading a source-less row as the caller's prompt", () => {
    // Rows written before `source` existed are all caller prompts, so an absent
    // field must not render as unknown or as the daemon's.
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "system/attach",
        turn: null,
        data: { charsLength: 1234, hash12: "abcdef123456" },
      }),
    ]);
    expect(rows[0].label).toBe("system prompt · 1,234 chars · hash abcdef123456…");
  });

  it("never renders prompt text even if one somehow reached the event", () => {
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "system/attach",
        turn: null,
        data: { charsLength: 12, hash12: "abc", systemPrompt: "SECRET PROMPT" },
      }),
    ]);
    expect(rows[0].label).not.toContain("SECRET");
  });

  it("maps a thinking/message event to a length-only reasoning row", () => {
    const rows = eventsToFoldRows([
      event({ seq: 1, type: "thinking/message", turn: "t1", data: { textLength: 512 } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("thinking");
    expect(rows[0]?.label).toBe("reasoning · 512 chars");
    expect(rows[0]?.textLength).toBe(512);
    expect(rows[0]?.durationMs).toBeNull();
  });

  it("lets a thinking row break a message run", () => {
    // Reasoning between two messages is its own thing, so the messages either
    // side of it are separate rows rather than one response.
    const rows = eventsToFoldRows([
      event({
        seq: 1,
        type: "assistant/message",
        data: { sourceMessageId: "m-1", textLength: 10 },
      }),
      event({ seq: 2, type: "thinking/message", turn: "t1", data: { textLength: 40 } }),
      event({
        seq: 3,
        type: "assistant/message",
        data: { sourceMessageId: "m-2", textLength: 12 },
      }),
    ]);
    expect(rows.filter((row) => row.kind === "message")).toHaveLength(2);
  });

  // --- QC r19 item 11: streamed append + thinking runs ---------------------

  it("shows one merged row growing as chunks of one response append", () => {
    // Exactly the live shape: the buffer grows one chunk at a time and is
    // re-folded each time, which is what the delta loop does on every flush.
    const buffer: TrajectoryEvent[] = [];
    const fold = () => eventsToFoldRows(buffer);
    const messages = () => fold().filter((row) => row.kind === "message");

    expect(messages()).toHaveLength(0);
    buffer.push(event({ seq: 1, type: "turn/start", data: {} }));
    buffer.push(
      event({ seq: 2, type: "assistant/message", data: { sourceMessageId: "m1", textLength: 1 } }),
    );
    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.textLength).toBe(1);

    buffer.push(
      event({ seq: 3, type: "assistant/message", data: { sourceMessageId: "m1", textLength: 68 } }),
    );
    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.textLength).toBe(68);

    buffer.push(
      event({ seq: 4, type: "assistant/message", data: { sourceMessageId: "m1", textLength: 90 } }),
    );
    expect(messages()).toHaveLength(1);
    expect(messages()[0]?.textLength).toBe(90);
    expect(messages()[0]?.segments).toBe(3);
  });

  it("renders a second response as a second row after a tool row", () => {
    const buffer: TrajectoryEvent[] = [];
    buffer.push(event({ seq: 1, type: "turn/start", data: {} }));
    buffer.push(
      event({ seq: 2, type: "assistant/message", data: { sourceMessageId: "m1", textLength: 10 } }),
    );
    buffer.push(
      event({ seq: 3, type: "assistant/message", data: { sourceMessageId: "m1", textLength: 20 } }),
    );
    buffer.push(
      event({
        seq: 4,
        type: "tool/result",
        data: { callId: "c1", name: "shell", outputChars: 2, isError: false, durationMs: 5 },
      }),
    );
    buffer.push(
      event({ seq: 5, type: "assistant/message", data: { sourceMessageId: "m2", textLength: 7 } }),
    );
    buffer.push(
      event({ seq: 6, type: "assistant/message", data: { sourceMessageId: "m2", textLength: 31 } }),
    );
    const messages = eventsToFoldRows(buffer).filter((row) => row.kind === "message");
    expect(messages).toHaveLength(2);
    expect(messages.map((row) => row.textLength)).toEqual([20, 31]);
    expect(messages.map((row) => row.segments)).toEqual([2, 2]);
  });

  it("collapses a streamed reasoning run into one row with the summed total", () => {
    // Reasoning arrives as SUFFIX deltas, so the run's total is the sum.
    const rows = eventsToFoldRows([
      event({ seq: 1, type: "thinking/message", turn: "t1", data: { textLength: 200 } }),
      event({ seq: 2, type: "thinking/message", turn: "t1", data: { textLength: 150 } }),
      event({ seq: 3, type: "thinking/message", turn: "t1", data: { textLength: 60 } }),
    ]);
    const thinking = rows.filter((row) => row.kind === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.textLength).toBe(410);
    expect(thinking[0]?.segments).toBe(3);
    expect(thinking[0]?.label).toBe("reasoning · 410 chars total");
  });

  it("keeps thinking and text as separate rows in a thinking-then-text response", () => {
    const rows = eventsToFoldRows([
      event({ seq: 1, type: "thinking/message", turn: "t1", data: { textLength: 100 } }),
      event({ seq: 2, type: "thinking/message", turn: "t1", data: { textLength: 50 } }),
      event({
        seq: 3,
        type: "assistant/message",
        turn: "t1",
        data: { sourceMessageId: "m1", textLength: 40 },
      }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["thinking", "message"]);
  });

  it("reports an unknown reasoning length as unknown rather than summing around it", () => {
    const rows = eventsToFoldRows([
      event({ seq: 1, type: "thinking/message", turn: "t1", data: { textLength: 200 } }),
      event({ seq: 2, type: "thinking/message", turn: "t1", data: {} }),
    ]);
    const thinking = rows.filter((row) => row.kind === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]?.textLength).toBeNull();
    expect(thinking[0]?.label).toBe("reasoning · — chars total");
  });
});
