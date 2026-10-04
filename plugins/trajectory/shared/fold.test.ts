import { describe, expect, test } from "vitest";
import { foldSnapshot } from "./fold.js";
import type { TrajectoryEvent } from "./trajectory.js";

let seq = 0;
function event(overrides: Partial<TrajectoryEvent> & { type: string }): TrajectoryEvent {
  seq += 1;
  return {
    seq,
    time: overrides.time ?? new Date(Date.parse("2026-09-26T00:00:00Z") + seq * 1000).toISOString(),
    turn: "t1",
    step: null,
    agentId: "agent-1",
    data: {},
    ...overrides,
  };
}

describe("foldSnapshot", () => {
  test("turn with user, message, tools folds into ordered turns/steps/cells", () => {
    const events = [
      event({ type: "user/message", data: { textLength: 42 } }),
      event({ type: "turn/start", data: { provider: "opencode" } }),
      event({ type: "step/start", step: 1 }),
      event({
        type: "assistant/message",
        step: 1,
        data: { textLength: 100, usage: { inputTokens: 10, outputTokens: 5 } },
      }),
      event({ type: "tool/call", data: { callId: "c1", name: "shell", argSummary: "npm test" } }),
      event({
        type: "tool/result",
        data: { callId: "c1", name: "shell", outputChars: 7, isError: false, durationMs: 1200 },
      }),
      event({
        type: "turn/end",
        data: {
          outcome: "completed",
          usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 9 },
        },
      }),
    ];
    const snapshot = foldSnapshot("agent-1", events, seq);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.headSeq).toBe(seq);
    const turn = snapshot.turns[0];
    expect(turn.outcome).toBe("completed");
    expect(turn.usage).toEqual({
      input: 12,
      cacheRead: 3,
      cacheWrite: null,
      output: 9,
      think: null,
    });
    expect(turn.users).toHaveLength(1);
    expect(turn.users[0].kind).toBe("user");
    expect(turn.steps).toHaveLength(1);
    expect(turn.steps[0].message?.usage).toEqual({
      input: 10,
      cacheRead: null,
      cacheWrite: null,
      output: 5,
      think: null,
    });
    const tool = turn.steps[0].tools[0];
    expect(tool.kind).toBe("tool");
    expect(tool.label).toBe("shell · npm test");
    expect(tool.outputChars).toBe(7);
    expect(tool.isError).toBe(false);
    // Own duration folds from the call/result TIME pair (1s apart), not the reported field.
    expect(tool.durationMs).toBe(1000);
    expect(tool.seqs).toHaveLength(2);
  });

  test("unreported values stay null (render —)", () => {
    const events = [
      event({ type: "turn/start" }),
      event({ type: "assistant/message", step: 1, data: {} }),
      event({ type: "tool/call", data: { callId: "c1", name: "read" } }),
      event({ type: "turn/end", data: { outcome: "completed" } }),
    ];
    const snapshot = foldSnapshot("agent-1", events, seq);
    const turn = snapshot.turns[0];
    expect(turn.usage).toBeNull();
    expect(turn.steps[0].message?.usage).toEqual({
      input: null,
      cacheRead: null,
      cacheWrite: null,
      output: null,
      think: null,
    });
    expect(turn.steps[0].message?.durationMs).toBeNull();
    const tool = turn.steps[0].tools[0];
    expect(tool.durationMs).toBeNull(); // result never seen -> in-flight
    expect(tool.outputChars).toBeNull();
  });

  test("tool call without result renders in-flight (no duration), result without call is its own row", () => {
    const events = [
      event({ type: "turn/start" }),
      event({ type: "tool/call", data: { callId: "c1", name: "fetch", argSummary: "https://x" } }),
      event({ type: "tool/result", data: { callId: "cOrphan", name: "shell", isError: true } }),
      event({ type: "turn/end", data: { outcome: "completed" } }),
    ];
    const snapshot = foldSnapshot("agent-1", events, seq);
    const tools = snapshot.turns[0].steps[0].tools;
    expect(tools).toHaveLength(2);
    expect(tools[0].label).toBe("fetch · https://x");
    expect(tools[0].durationMs).toBeNull();
    expect(tools[1].label).toBe("shell");
    expect(tools[1].isError).toBe(true);
    expect(tools[1].durationMs).toBeNull();
  });

  test("failed turn carries outcome and error; canceled maps", () => {
    const events = [
      event({ type: "turn/start" }),
      event({ type: "turn/end", data: { outcome: "failed", error: "boom" } }),
      event({ type: "turn/start", turn: "t2" }),
      event({ type: "turn/end", turn: "t2", data: { outcome: "canceled" } }),
    ];
    const snapshot = foldSnapshot("agent-1", events, seq);
    expect(snapshot.turns[0].outcome).toBe("failed");
    expect(snapshot.turns[0].error).toBe("boom");
    expect(snapshot.turns[1].outcome).toBe("canceled");
  });

  test("user row before any turn is an orphan; turn=null rows never fabricate turns", () => {
    const events = [event({ type: "user/message", turn: null, data: { textLength: 3 } })];
    const snapshot = foldSnapshot("agent-1", events, seq);
    expect(snapshot.turns).toHaveLength(0);
    expect(snapshot.orphans).toHaveLength(1);
    expect(snapshot.orphans[0].kind).toBe("user");
  });

  test("steps split per step number and stay in encounter order", () => {
    const events = [
      event({ type: "turn/start" }),
      event({ type: "assistant/message", step: 1, data: { textLength: 5 } }),
      event({ type: "tool/call", step: 1, data: { callId: "c1", name: "read" } }),
      event({ type: "assistant/message", step: 2, data: { textLength: 6 } }),
      event({ type: "turn/end", data: { outcome: "completed" } }),
    ];
    const snapshot = foldSnapshot("agent-1", events, seq);
    const steps = snapshot.turns[0].steps;
    expect(steps.map((step) => step.step)).toEqual([1, 2]);
    expect(steps[0].tools).toHaveLength(1);
    expect(steps[1].message?.label).toContain("6 chars");
  });
});
