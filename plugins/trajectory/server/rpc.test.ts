import { describe, expect, test } from "vitest";
import { foldSnapshot } from "../shared/fold.js";
import { TrajectorySnapshotSchema, trajectoryList } from "../shared/trajectory.js";
import { createNodeStore } from "./node-store.js";
import { handleChanges, handleList } from "./rpc.js";

describe("trajectory read handlers", () => {
  test("list returns ascending events + headSeq; changes returns only newer rows", async () => {
    const store = createNodeStore(":memory:");
    const base = Date.parse("2026-09-26T00:00:00Z");
    const rows = [
      { type: "turn/start", turn: "t1", data: {} },
      { type: "assistant/message", turn: "t1", step: 1, data: { textLength: 9 } },
      { type: "turn/end", turn: "t1", data: { outcome: "completed" } },
    ];
    for (const [index, row] of rows.entries()) {
      store.append({
        ...row,
        time: new Date(base + index * 1000).toISOString(),
        step: row.step ?? null,
        agentId: "agent-1",
      });
    }

    const list = await handleList(store)({ agentId: "agent-1", limit: 100 });
    expect(list.events).toHaveLength(3);
    expect(list.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(list.headSeq).toBe(3);

    const changes = await handleChanges(store)({ agentId: "agent-1", afterSeq: 2, limit: 100 });
    expect(changes.events.map((event) => event.type)).toEqual(["turn/end"]);
    expect(changes.headSeq).toBe(3);

    // The wire contract parses the list output (schema round-trip).
    const parsed = trajectoryList.output.parse(list);
    expect(parsed.events[0].agentId).toBe("agent-1");

    // And the fold accepts the same rows end-to-end.
    const snapshot = foldSnapshot("agent-1", parsed.events, parsed.headSeq);
    expect(TrajectorySnapshotSchema.parse(snapshot).turns).toHaveLength(1);
    store.close();
  });

  test("unknown agent: empty page, headSeq 0", async () => {
    const store = createNodeStore(":memory:");
    const list = await handleList(store)({ agentId: "nobody", limit: 50 });
    expect(list.events).toEqual([]);
    expect(list.headSeq).toBe(0);
    store.close();
  });
});
