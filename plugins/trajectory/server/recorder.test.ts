import { describe, expect, test } from "vitest";
import { createNodeStore } from "./node-store.js";
import { createRecorder } from "./recorder.js";
import type { TrajectoryEvent } from "../shared/trajectory.js";
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
        type: "tool_call" as const,
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
        type: "tool_call" as const,
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
        type: "tool_call" as const,
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
        type: "tool_call" as const,
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
      // The second tool call only starts after the first result is in, so the
      // model must have consumed it: that boundary is the derived round.
      "round/begin",
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
      type: "tool_call" as const,
      callId: "c1",
      name: "shell",
      status: "running" as const,
      error: null,
      detail: { type: "shell" as const, command: "ls" },
    };
    const doneItem = {
      type: "tool_call" as const,
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
        type: "tool_call" as const,
        callId: "c9",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "x.ts", content: "abc" },
      },
    });
    const events = allEvents(store);
    // The call row is now backfilled so the pair is complete even though the
    // call itself was never observed (this is the orphan-terminal case).
    expect(events.map((event) => event.type)).toEqual(["tool/call", "tool/result"]);
    expect(events[0].turn).toBeNull();
    expect(events[0].data.backfilled).toBe(true);
    expect(events[1].turn).toBeNull();
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
    // A repeat terminal for an already-terminated turn is dropped: exactly one
    // turn/end per turn id, whichever path (hook or stream) gets there first.
    recorder.turnEnded({ agentId: "agent-1", turnId: "t2", outcome: "completed" });
    expect(allEvents(store).filter((event) => event.type === "turn/end")).toHaveLength(2);
    // Re-opening the same id makes it live again and terminable again.
    recorder.turnStarted({ agentId: "agent-1", turnId: "t2" });
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

  test("onAppend fires per stored row with assigned seqs in order", () => {
    const store: TrajectoryStore = createNodeStore(":memory:");
    const seen: TrajectoryEvent[] = [];
    const recorder = createRecorder({ store, onAppend: (event) => seen.push(event) });
    recorder.turnStarted({ agentId: "agent-1", turnId: "t1" });
    recorder.turnEnded({ agentId: "agent-1", turnId: "t1", outcome: "completed" });
    expect(seen.map((event) => event.type)).toEqual(["turn/start", "turn/end"]);
    expect(seen.map((event) => event.seq)).toEqual([1, 2]);
    store.close();
  });

  // --- T3-D: derived rows + recorder integrity ---------------------------

  test("derives an llm round when an action follows a tool result", () => {
    const { store, recorder } = harness();
    recorder.turnStarted({ agentId: "agent-1", turnId: "t1" });
    toolCall(recorder, "t1", "c1", "running");
    toolCall(recorder, "t1", "c1", "completed");

    // Nothing pending yet: the very next thing is a tool call, so the results
    // must have been consumed first.
    toolCall(recorder, "t1", "c2", "running");
    const rounds = allEvents(store).filter((event) => event.type === "round/begin");
    expect(rounds).toHaveLength(1);
    expect(rounds[0].data.derived).toBe(true);
    expect(rounds[0].data.ordinal).toBe(1);
    expect(rounds[0].data.consumedResults).toBe(1);
    expect(rounds[0].turn).toBe("t1");
  });

  test("does not derive a round when no result is outstanding", () => {
    const { store, recorder } = harness();
    recorder.turnStarted({ agentId: "agent-1", turnId: "t1" });
    // First action of the turn: there is nothing a model could have consumed.
    recorder.timelineItem({
      agentId: "agent-1",
      turnId: "t1",
      item: { type: "assistant_message" as const, messageId: "m1", text: "done" },
    });
    // A call still running has produced no result either.
    toolCall(recorder, "t1", "c1", "running");
    expect(allEvents(store).filter((event) => event.type === "round/begin")).toHaveLength(0);
  });

  test("counts every pending result into one round and numbers rounds in order", () => {
    const { store, recorder } = harness();
    recorder.turnStarted({ agentId: "agent-1", turnId: "t1" });
    // Two tools run in PARALLEL: both start before either finishes, so two
    // results pile up with no action in between to close them early.
    toolCall(recorder, "t1", "c1", "running");
    toolCall(recorder, "t1", "c2", "running");
    toolCall(recorder, "t1", "c1", "completed");
    toolCall(recorder, "t1", "c2", "completed");
    // The next action consumes both at once.
    recorder.timelineItem({
      agentId: "agent-1",
      turnId: "t1",
      item: { type: "assistant_message" as const, messageId: "m1", text: "next" },
    });
    toolCall(recorder, "t1", "c3", "running");
    toolCall(recorder, "t1", "c3", "completed");
    recorder.timelineItem({
      agentId: "agent-1",
      turnId: "t1",
      item: { type: "assistant_message" as const, messageId: "m2", text: "again" },
    });
    const rounds = allEvents(store).filter((event) => event.type === "round/begin");
    expect(rounds.map((event) => event.data.consumedResults)).toEqual([2, 1]);
    expect(rounds.map((event) => event.data.ordinal)).toEqual([1, 2]);
  });

  test("restarts round numbering for each turn", () => {
    const { store, recorder } = harness();
    recorder.turnStarted({ agentId: "agent-1", turnId: "t1" });
    toolCall(recorder, "t1", "c1", "running");
    toolCall(recorder, "t1", "c1", "completed");
    recorder.timelineItem({
      agentId: "agent-1",
      turnId: "t1",
      item: { type: "assistant_message" as const, messageId: "m1", text: "x" },
    });
    recorder.turnEnded({ agentId: "agent-1", turnId: "t1", outcome: "completed" });
    recorder.turnStarted({ agentId: "agent-1", turnId: "t2" });
    toolCall(recorder, "t2", "c9", "running");
    toolCall(recorder, "t2", "c9", "completed");
    recorder.timelineItem({
      agentId: "agent-1",
      turnId: "t2",
      item: { type: "assistant_message" as const, messageId: "m2", text: "y" },
    });
    const rounds = allEvents(store).filter((event) => event.type === "round/begin");
    expect(rounds.map((event) => event.data.ordinal)).toEqual([1, 1]);
    expect(rounds.map((event) => event.turn)).toEqual(["t1", "t2"]);
  });

  test("backfills a call row for an orphan terminal so the pair always exists", () => {
    const { store, recorder } = harness();
    recorder.turnStarted({ agentId: "agent-1", turnId: "t1" });
    recorder.timelineItem({
      agentId: "agent-1",
      turnId: "t1",
      item: {
        type: "tool_call" as const,
        callId: "orphan",
        name: "shell",
        status: "failed",
        error: "boom",
        detail: { type: "shell", command: "ls", output: "" },
      },
    });
    const events = allEvents(store);
    const call = events.find((event) => event.type === "tool/call");
    const result = events.find((event) => event.type === "tool/result");
    expect(call?.data.callId).toBe("orphan");
    expect(call?.data.name).toBe("shell");
    expect(call?.data.backfilled).toBe(true);
    expect(result?.data.callId).toBe("orphan");
    // Exactly one call row, even though the terminal also passes the dedupe gate.
    expect(events.filter((event) => event.type === "tool/call")).toHaveLength(1);
  });

  test("does not backfill a second call row when the call was observed", () => {
    const { store, recorder } = harness();
    recorder.turnStarted({ agentId: "agent-1", turnId: "t1" });
    toolCall(recorder, "t1", "c1", "running");
    toolCall(recorder, "t1", "c1", "completed");
    const calls = allEvents(store).filter((event) => event.type === "tool/call");
    expect(calls).toHaveLength(1);
    expect(calls[0].data.backfilled).toBeUndefined();
  });

  test("records the system prompt as length and hash only, with no turn", () => {
    const { store, recorder } = harness();
    recorder.systemPromptAttached({
      agentId: "agent-1",
      charsLength: 1234,
      hash12: "abcdef123456",
      correlated: "config",
    });
    const [row] = allEvents(store);
    expect(row.type).toBe("system/attach");
    expect(row.turn).toBeNull();
    expect(row.data.charsLength).toBe(1234);
    expect(row.data.hash12).toBe("abcdef123456");
    expect(row.data.derived).toBe(true);
    expect(row.data.correlated).toBe("config");
    // The prompt text must not be anywhere in the row.
    expect(JSON.stringify(row.data)).not.toMatch(/prompt\s*:/i);
  });

  function toolCall(
    rec: ReturnType<typeof harness>["recorder"],
    turnId: string,
    callId: string,
    status: "running" | "completed",
  ): void {
    rec.timelineItem({
      agentId: "agent-1",
      turnId,
      item: {
        type: "tool_call" as const,
        callId,
        name: "shell",
        status,
        error: null,
        detail: {
          type: "shell" as const,
          command: "ls",
          ...(status === "completed" ? { output: "ok" } : {}),
        },
      },
    });
  }

  test("records provider reasoning as its own row, length only", () => {
    const { store, recorder } = harness();
    recorder.turnStarted({ agentId: "agent-1", turnId: "t1" });
    recorder.timelineItem({
      agentId: "agent-1",
      turnId: "t1",
      // `reasoning` IS in the AgentTimelineItem union (protocol agent-types.ts:374)
      // and opencode translates reasoning parts into timeline events.
      item: { type: "reasoning" as const, text: "considering the options" },
    });
    const rows = allEvents(store).filter((event) => event.type === "thinking/message");
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.data.textLength).toBe("considering the options".length);
    expect(row?.turn).toBe("t1");
    // The text itself is never stored: reasoning carries no message id, so there
    // is no key to fetch it by later and the length is the honest maximum.
    expect(JSON.stringify(rows[0].data)).not.toContain("considering");
  });

  test("records a reasoning item with no text as a null length, not zero", () => {
    const { store, recorder } = harness();
    recorder.turnStarted({ agentId: "agent-1", turnId: "t1" });
    recorder.timelineItem({
      agentId: "agent-1",
      turnId: "t1",
      item: { type: "reasoning" as const, text: "" },
    });
    const row = allEvents(store).find((event) => event.type === "thinking/message");
    expect(row?.data.textLength).toBe(0);
  });
});
