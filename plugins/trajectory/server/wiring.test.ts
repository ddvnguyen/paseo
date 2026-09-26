import { describe, expect, test } from "vitest";
import { createNodeStore } from "./node-store.js";
import { createWiring, type PaseoLike } from "./wiring.js";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

type TimelineHandler = (update: { event: { type: string } & Record<string, unknown> }) => void;

function fakePaseo() {
  const agents = new Map<string, TimelineHandler>();
  const released: string[] = [];
  let directoryReleased = false;

  const paseo: PaseoLike = {
    agents: {
      list: async () => ({
        entries: [{ agent: { id: "agent-A", provider: "opencode" } }],
        subscription: {
          subscribe() {},
          release() {
            directoryReleased = true;
          },
        },
      }),
      ref: (agentId: string) => ({
        timeline: {
          subscribe(handler: TimelineHandler) {
            agents.set(agentId, handler);
            return {
              ready: Promise.resolve(),
              release: () => {
                agents.delete(agentId);
                released.push(agentId);
              },
            };
          },
        },
      }),
    },
  };

  return {
    paseo,
    emit(agentId: string, event: { type: string } & Record<string, unknown>) {
      agents.get(agentId)?.({ event });
    },
    released,
    get directoryReleased() {
      return directoryReleased;
    },
    hasSub(agentId: string) {
      return agents.has(agentId);
    },
  };
}

const assistantItem: AgentTimelineItem = {
  type: "assistant_message",
  text: "hello",
};

describe("wiring", () => {
  test("(a) ensureAttached called 3 times attaches exactly once", async () => {
    const fake = fakePaseo();
    const wiring = createWiring({ store: createNodeStore(":memory:") });
    wiring.ensureAttached(fake.paseo);
    wiring.ensureAttached(fake.paseo);
    wiring.ensureAttached(fake.paseo);
    expect(wiring.attached).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.hasSub("agent-A")).toBe(true);
    return wiring.cleanup();
  });

  test("(b) a fake timeline update for agent A is recorded and readable", async () => {
    const fake = fakePaseo();
    const store = createNodeStore(":memory:");
    const wiring = createWiring({ store });
    wiring.ensureAttached(fake.paseo);
    // Let the directory promise resolve and attach.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.emit("agent-A", { type: "timeline", item: assistantItem, turnId: "t1" });
    const events = store.listByAgent("agent-A", { limit: 10 });
    expect(events.length).toBeGreaterThanOrEqual(3); // step/start, message, step/end
    const message = events.find((event) => event.type === "assistant/message")!;
    expect(message.agentId).toBe("agent-A");
    expect(message.turn).toBe("t1");
    await wiring.cleanup();
  });

  test("(c) hook turn_started before any stream attach still records turn/start", () => {
    const store = createNodeStore(":memory:");
    const wiring = createWiring({ store });
    wiring.recorder.turnStarted({ agentId: "agent-B", turnId: "t9", provider: "claude" });
    const events = store.listByAgent("agent-B", { limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("turn/start");
    expect(events[0].turn).toBe("t9");
    return wiring.cleanup();
  });

  test("(d) cleanup runs disposers", async () => {
    const fake = fakePaseo();
    const wiring = createWiring({ store: createNodeStore(":memory:") });
    wiring.ensureAttached(fake.paseo);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.hasSub("agent-A")).toBe(true);
    await wiring.cleanup();
    expect(fake.hasSub("agent-A")).toBe(false);
    expect(fake.released).toContain("agent-A");
    expect(fake.directoryReleased).toBe(true);
  });
});
