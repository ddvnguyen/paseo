import { describe, expect, test } from "vitest";
import { createNodeStore } from "./node-store.js";
import { createRecorder } from "./recorder.js";
import type { TrajectoryEvent } from "../shared/events.js";
import type { TrajectoryStore } from "./store.js";

function harness() {
  const store: TrajectoryStore = createNodeStore(":memory:");
  let tick = 0;
  const recorder = createRecorder({
    store,
    now: () => new Date((tick += 1000)),
  });
  return { store, recorder };
}

function allEvents(store: TrajectoryStore): TrajectoryEvent[] {
  // A single catch-all agent is not available; read per known agent ids.
  const agents = ["agent-1", "agent-2"];
  return agents
    .flatMap((agentId) => store.listByAgent(agentId, { limit: 1000 }))
    .sort((a, b) => a.seq - b.seq);
}

describe("recorder", () => {
  test("(a) turn with 2 tool calls: ordered rows, turn set, durationMs computed", () => {
    const { store, recorder } = harness();
    recorder.turnStarted({ agentId: "agent-1", turnId: "t1", provider: "opencode" });
    recorder.timelineItem({
      agentId: "agent-1",
      turnId: "t1",
      item: {
        type: "tool_call",
        callId: "c1",
        name: "shell",
        status: "running",
        error: null,
        detail: { type: "shell", command: "npm run typecheck" },
      },
    });
    recorder.timelineItem({
      agentId: "agent-1",
      turnId: "t1",
      item: {
        type: "tool_call",
        callId: "c1",
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm run typecheck", output: "ok" },
      },
    });
    recorder.timelineItem({
      agentId: "agent-1",
      turnId: "t1",
      item: {
        type: "tool_call",
        callId: "c2",
        name: "read",
        status: "running",
        error: null,
        detail: { type: "read", filePath: "src/a.ts" },
      },
    });
    recorder.timelineItem({
      agentId: "agent-1",
      turnId: "t1",
      item: {
        type: "tool_call",
        callId: "c2",
        name: "read",
        status: "failed",
        error: "boom",
        detail: { type: "read", filePath: "src/a.ts" },
      },
    });
    recorder.turnEnded({ agentId: "agent-1", turnId: "t1", outcome: "completed" });

    const events = allEvents(store);
    const types = events.map((event) => event.type);
    expect(types).toEqual([
      "turn/start",
      "tool/call",
      "tool/result",
      "tool/call",
      "tool/result",
      "turn/end",
    ]);
    for (const event of events) expect(event.turn).toBe("t1");
    const call = events.find((event) => event.type === "tool/call")!;
    expect(call.data.callId).toBe("c1");
    expect(call.data.argSummary).toBe("npm run typecheck");
    const result = events.find((event) => event.type === "tool/result")!;
    expect(result.data.outputChars).toBe(2);
    expect(result.data.durationMs).toBeGreaterThan(0);
    const failed = events.filter((event) => event.type === "tool/result")[1];
    expect(failed.data.isError).toBe(true);
    expect(failed.data.durationMs).toBeGreaterThan(0);
  });

  test("(b) replaying the same timeline items twice writes each tool row once", () => {
    const { store, recorder } = harness();
    recorder.turnStarted({ agentId: "agent-1", turnId: "t1" });
    const runningItem = {
      type: "tool_call",
      callId: "c1",
      name: "shell",
      status: "running" as const,
      error: null,
      detail: { type: "shell" as const, command: "ls" },
    };
    const doneItem = {
      type: "tool_call",
      callId: "c1",
      name: "shell",
      status: "completed" as const,
      error: null,
      detail: { type: "shell" as const, command: "ls", output: "a" },
    };
    for (let i = 0; i < 2; i++) {
      recorder.timelineItem({ agentId: "agent-1", turnId: "t1", item: runningItem });
      recorder.timelineItem({ agentId: "agent-1", turnId: "t1", item: doneItem });
    }
    const events = allEvents(store);
    expect(events.filter((event) => event.type === "tool/call")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool/result")).toHaveLength(1);
  });

  test("(c) tool item with no open turn: stored with turn=null, creates no turn", () => {
    const { store, recorder } = harness();
    recorder.timelineItem({
      agentId: "agent-1",
      item: {
        type: "tool_call",
        callId: "c9",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "x.ts", content: "abc" },
      },
    });
    const events = allEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool/result");
    expect(events[0].turn).toBeNull();
    // No turn/start or turn/end rows were fabricated.
    expect(allEvents(store).some((event) => event.type.startsWith("turn/"))).toBe(false);
  });

  test("(d) two consecutive turns both get turn/end", () => {
    const { store, recorder } = harness();
    recorder.turnStarted({ agentId: "agent-1", turnId: "t1" });
    recorder.turnEnded({ agentId: "agent-1", turnId: "t1", outcome: "completed" });
    recorder.turnStarted({ agentId: "agent-1", turnId: "t2" });
    recorder.turnEnded({ agentId: "agent-1", turnId: "t2", outcome: "failed", error: "nope" });

    const events = allEvents(store);
    const ends = events.filter((event) => event.type === "turn/end");
    expect(ends).toHaveLength(2);
    expect(ends.map((event) => event.turn)).toEqual(["t1", "t2"]);
    expect(ends[0].data.outcome).toBe("completed");
    expect(ends[1].data.outcome).toBe("failed");
    expect(ends[1].data.error).toBe("nope");
    // No open turns remain for the agent.
    recorder.turnEnded({ agentId: "agent-1", turnId: "t2", outcome: "completed" });
    expect(allEvents(store).filter((event) => event.type === "turn/end")).toHaveLength(3);
  });

  test("(e) usage absent -> nulls in turn/end", () => {
    const { store, recorder } = harness();
    recorder.turnStarted({ agentId: "agent-2", turnId: "u1" });
    recorder.turnEnded({ agentId: "agent-2", turnId: "u1", outcome: "completed" });
    const events = allEvents(store);
    const end = events.find((event) => event.type === "turn/end")!;
    // Usage object is always present; every field is null when unreported.
    const usage = end.data.usage as Record<string, unknown>;
    expect(usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningTokens: null,
    });
  });
});
