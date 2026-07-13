import { describe, expect, test, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { EventBus, type AgentCompletionEvent } from "./event-bus.js";

function createTestEvent(
  overrides: Partial<AgentCompletionEvent> & { parentAgentId: string; agentId: string },
): AgentCompletionEvent {
  return {
    id: overrides.id ?? `evt-${Math.random().toString(36).slice(2, 8)}`,
    type: overrides.type ?? "agent.completed",
    agentId: overrides.agentId,
    agentName: overrides.agentName,
    parentAgentId: overrides.parentAgentId,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    exitCode: overrides.exitCode,
    duration: overrides.duration,
    finalOutput: overrides.finalOutput,
    labels: overrides.labels,
    worktree: overrides.worktree,
    provider: overrides.provider,
  };
}

describe("EventBus", () => {
  let tmpDir: string;
  let eventBus: EventBus;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "event-bus-test-"));
    const logger = createTestLogger();
    eventBus = new EventBus({ paseoHome: tmpDir, logger });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("emit and query", () => {
    test("emits and queries events by parentAgentId", async () => {
      await eventBus.initialize();

      const event1 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-1" });
      const event2 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-2" });
      const event3 = createTestEvent({ parentAgentId: "parent-2", agentId: "child-3" });

      eventBus.emit(event1);
      eventBus.emit(event2);
      eventBus.emit(event3);

      const results = eventBus.query({ parentAgentId: "parent-1" });
      expect(results).toHaveLength(2);
      expect(results[0].agentId).toBe("child-1");
      expect(results[1].agentId).toBe("child-2");
    });

    test("queries events by childAgentId", async () => {
      await eventBus.initialize();

      const event1 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-1" });
      const event2 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-2" });

      eventBus.emit(event1);
      eventBus.emit(event2);

      const results = eventBus.query({ childAgentId: "child-1" });
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe("child-1");
    });

    test("queries events by time range", async () => {
      await eventBus.initialize();

      const event1 = createTestEvent({
        parentAgentId: "parent-1",
        agentId: "child-1",
        timestamp: "2024-01-01T00:00:00Z",
      });
      const event2 = createTestEvent({
        parentAgentId: "parent-1",
        agentId: "child-2",
        timestamp: "2024-01-02T00:00:00Z",
      });
      const event3 = createTestEvent({
        parentAgentId: "parent-1",
        agentId: "child-3",
        timestamp: "2024-01-03T00:00:00Z",
      });

      eventBus.emit(event1);
      eventBus.emit(event2);
      eventBus.emit(event3);

      const results = eventBus.query({
        parentAgentId: "parent-1",
        since: "2024-01-01T12:00:00Z",
        until: "2024-01-02T12:00:00Z",
      });
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe("child-2");
    });

    test("queries events by event type", async () => {
      await eventBus.initialize();

      const event1 = createTestEvent({
        parentAgentId: "parent-1",
        agentId: "child-1",
        type: "agent.completed",
      });
      const event2 = createTestEvent({
        parentAgentId: "parent-1",
        agentId: "child-2",
        type: "agent.failed",
      });

      eventBus.emit(event1);
      eventBus.emit(event2);

      const completed = eventBus.query({ eventTypes: ["agent.completed"] });
      expect(completed).toHaveLength(1);
      expect(completed[0].type).toBe("agent.completed");

      const failed = eventBus.query({ eventTypes: ["agent.failed"] });
      expect(failed).toHaveLength(1);
      expect(failed[0].type).toBe("agent.failed");
    });
  });

  describe("drain", () => {
    test("drains all events for a parent", async () => {
      await eventBus.initialize();

      const event1 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-1" });
      const event2 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-2" });

      eventBus.emit(event1);
      eventBus.emit(event2);

      const result = eventBus.drain("parent-1");
      expect(result.drained).toHaveLength(2);
      expect(result.cursor).toBeDefined();
    });

    test("drains up to specific event ID", async () => {
      await eventBus.initialize();

      const event1 = createTestEvent({
        parentAgentId: "parent-1",
        agentId: "child-1",
        id: "evt-1",
      });
      const event2 = createTestEvent({
        parentAgentId: "parent-1",
        agentId: "child-2",
        id: "evt-2",
      });

      eventBus.emit(event1);
      eventBus.emit(event2);

      const result = eventBus.drain("parent-1", { upToEventId: "evt-1" });
      expect(result.drained).toHaveLength(1);
      expect(result.drained[0].id).toBe("evt-1");
      expect(result.cursor).toBe("evt-1");
    });

    test("does not re-drain already drained events", async () => {
      await eventBus.initialize();

      const event1 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-1" });
      const event2 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-2" });

      eventBus.emit(event1);
      eventBus.emit(event2);

      // First drain
      const result1 = eventBus.drain("parent-1");
      expect(result1.drained).toHaveLength(2);

      // Second drain should return empty
      const result2 = eventBus.drain("parent-1");
      expect(result2.drained).toHaveLength(0);
    });

    test("new events after drain are not drained", async () => {
      await eventBus.initialize();

      const event1 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-1" });
      eventBus.emit(event1);

      // Drain first event
      eventBus.drain("parent-1");

      // Add new event
      const event2 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-2" });
      eventBus.emit(event2);

      // Should only see new event
      const result = eventBus.drain("parent-1");
      expect(result.drained).toHaveLength(1);
      expect(result.drained[0].agentId).toBe("child-2");
    });
  });

  describe("subscriptions", () => {
    test("creates and lists subscriptions", async () => {
      await eventBus.initialize();

      const sub1 = eventBus.subscribe("parent-1", { childFilter: "child-1" });
      const sub2 = eventBus.subscribe("parent-1", { eventTypes: ["agent.completed"] });

      const subs = eventBus.listSubscriptions("parent-1");
      expect(subs).toHaveLength(2);
      expect(subs[0].id).toBe(sub1.id);
      expect(subs[1].id).toBe(sub2.id);
    });

    test("unsubscribes by subscription ID", async () => {
      await eventBus.initialize();

      const sub1 = eventBus.subscribe("parent-1", {});
      const sub2 = eventBus.subscribe("parent-1", {});

      const success = eventBus.unsubscribe("parent-1", sub1.id);
      expect(success).toBe(true);

      const subs = eventBus.listSubscriptions("parent-1");
      expect(subs).toHaveLength(1);
      expect(subs[0].id).toBe(sub2.id);
    });

    test("unsubscribes all for a parent", async () => {
      await eventBus.initialize();

      eventBus.subscribe("parent-1", {});
      eventBus.subscribe("parent-1", {});

      const success = eventBus.unsubscribe("parent-1");
      expect(success).toBe(true);

      const subs = eventBus.listSubscriptions("parent-1");
      expect(subs).toHaveLength(0);
    });

    test("returns false when unsubscribing non-existent parent", async () => {
      await eventBus.initialize();

      const success = eventBus.unsubscribe("non-existent");
      expect(success).toBe(false);
    });
  });

  describe("persistence", () => {
    test("persists and loads from file", async () => {
      // First event bus instance
      const logger1 = createTestLogger();
      const bus1 = new EventBus({ paseoHome: tmpDir, logger: logger1 });
      await bus1.initialize();

      const event1 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-1" });
      bus1.emit(event1);

      bus1.subscribe("parent-1", { childFilter: "child-1" });
      bus1.drain("parent-1");

      // Wait for persist
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Second event bus instance (simulates daemon restart)
      const logger2 = createTestLogger();
      const bus2 = new EventBus({ paseoHome: tmpDir, logger: logger2 });
      await bus2.initialize();

      // Verify events are loaded
      const events = bus2.query({ parentAgentId: "parent-1" });
      expect(events).toHaveLength(1);
      expect(events[0].agentId).toBe("child-1");

      // Verify subscriptions are loaded
      const subs = bus2.listSubscriptions("parent-1");
      expect(subs).toHaveLength(1);
      expect(subs[0].childFilter).toBe("child-1");

      // Verify cursor is loaded (drained events not re-drained)
      const drained = bus2.drain("parent-1");
      expect(drained.drained).toHaveLength(0);
    });

    test("creates events directory if it doesn't exist", async () => {
      const logger = createTestLogger();
      const bus = new EventBus({ paseoHome: tmpDir, logger });
      await bus.initialize();

      const event = createTestEvent({ parentAgentId: "parent-1", agentId: "child-1" });
      bus.emit(event);

      // Wait for persist
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Check file exists
      const eventsFile = path.join(tmpDir, "events", "events.json");
      expect(existsSync(eventsFile)).toBe(true);
    });
  });

  describe("maxEvents", () => {
    test("trims old events when exceeding maxEvents", async () => {
      const logger = createTestLogger();
      const bus = new EventBus({ paseoHome: tmpDir, logger, maxEvents: 3 });
      await bus.initialize();

      const event1 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-1" });
      const event2 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-2" });
      const event3 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-3" });
      const event4 = createTestEvent({ parentAgentId: "parent-1", agentId: "child-4" });

      bus.emit(event1);
      bus.emit(event2);
      bus.emit(event3);
      bus.emit(event4);

      const events = bus.query({ parentAgentId: "parent-1" });
      expect(events).toHaveLength(3);
      expect(events[0].agentId).toBe("child-2");
      expect(events[1].agentId).toBe("child-3");
      expect(events[2].agentId).toBe("child-4");
    });
  });
});
