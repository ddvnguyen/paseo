import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import { writeJsonFileAtomic } from "../atomic-file.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentCompletionEvent {
  id: string;
  type: "agent.completed" | "agent.failed" | "agent.cancelled";
  agentId: string;
  agentName?: string;
  parentAgentId: string;
  timestamp: string;

  // Completion details
  exitCode?: number;
  duration?: number;
  finalOutput?: string;

  // Context
  labels?: Record<string, string>;
  worktree?: string;
  provider?: string;
}

export interface Subscription {
  id: string;
  parentAgentId: string;
  childFilter?: string;
  eventTypes?: string[];
  createdAt: string;
}

export interface QueryOptions {
  parentAgentId?: string;
  childAgentId?: string;
  since?: string;
  until?: string;
  eventTypes?: string[];
}

export interface DrainOptions {
  upToEventId?: string;
  olderThan?: string;
}

interface EventStorePayload {
  events: AgentCompletionEvent[];
  cursors: Record<string, string>;
  subscriptions: Subscription[];
}

interface DrainResult {
  drained: AgentCompletionEvent[];
  cursor: string | null;
}

// ─── EventBus ─────────────────────────────────────────────────────────────────

export class EventBus {
  private events: AgentCompletionEvent[] = [];
  private cursors: Map<string, string> = new Map();
  private subscriptions: Map<string, Subscription[]> = new Map();
  private filePath: string;
  private logger: Logger;
  private loaded = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private maxEvents: number;

  constructor(options: { paseoHome: string; logger: Logger; maxEvents?: number }) {
    this.filePath = path.join(options.paseoHome, "events", "events.json");
    this.logger = options.logger.child({ component: "event-bus" });
    this.maxEvents = options.maxEvents ?? 1000;
  }

  async initialize(): Promise<void> {
    await this.load();
  }

  // ─── Emit ──────────────────────────────────────────────────────────────────

  emit(event: AgentCompletionEvent): void {
    this.events.push(event);

    // Trim old events
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }

    this.logger.debug(
      {
        eventId: event.id,
        type: event.type,
        agentId: event.agentId,
        parentAgentId: event.parentAgentId,
      },
      "event emitted",
    );

    // Persist (async, non-blocking)
    this.schedulePersist();
  }

  // ─── Query (read without drain) ────────────────────────────────────────────

  query(options: QueryOptions): AgentCompletionEvent[] {
    return this.events.filter((e) => {
      if (options.parentAgentId && e.parentAgentId !== options.parentAgentId) return false;
      if (options.childAgentId && e.agentId !== options.childAgentId) return false;
      if (options.since && e.timestamp < options.since) return false;
      if (options.until && e.timestamp > options.until) return false;
      if (options.eventTypes && !options.eventTypes.includes(e.type)) return false;
      return true;
    });
  }

  // ─── Drain (acknowledge and advance cursor) ────────────────────────────────

  drain(parentAgentId: string, options: DrainOptions = {}): DrainResult {
    const allEvents = this.query({ parentAgentId });

    // Get events since last cursor (undrained) - use index-based comparison
    const currentCursor = this.cursors.get(parentAgentId);
    let undrained: AgentCompletionEvent[];
    if (currentCursor) {
      // Find the index of the cursor event and get events after it
      const cursorIndex = allEvents.findIndex((e) => e.id === currentCursor);
      undrained = cursorIndex >= 0 ? allEvents.slice(cursorIndex + 1) : allEvents;
    } else {
      undrained = allEvents;
    }

    // Find the event to drain up to (from undrained events)
    let drainUpTo: AgentCompletionEvent | undefined;
    if (options.upToEventId) {
      drainUpTo = undrained.find((e) => e.id === options.upToEventId);
    } else if (options.olderThan) {
      const older = undrained.filter((e) => e.timestamp < options.olderThan!);
      drainUpTo = older[older.length - 1];
    } else {
      // Drain all undrained events
      drainUpTo = undrained[undrained.length - 1];
    }

    // Get events to return (up to and including drainUpTo)
    let drained: AgentCompletionEvent[];
    if (drainUpTo) {
      const drainUpToIndex = undrained.findIndex((e) => e.id === drainUpTo!.id);
      drained = undrained.slice(0, drainUpToIndex + 1);
      // Update cursor
      this.cursors.set(parentAgentId, drainUpTo.id);
      this.schedulePersist();
    } else {
      drained = [];
    }

    return {
      drained,
      cursor: drainUpTo?.id ?? null,
    };
  }

  // ─── Subscription Management ───────────────────────────────────────────────

  subscribe(
    parentAgentId: string,
    opts: { childFilter?: string; eventTypes?: string[] },
  ): Subscription {
    const sub: Subscription = {
      id: randomUUID(),
      parentAgentId,
      childFilter: opts.childFilter,
      eventTypes: opts.eventTypes,
      createdAt: new Date().toISOString(),
    };

    const subs = this.subscriptions.get(parentAgentId) ?? [];
    subs.push(sub);
    this.subscriptions.set(parentAgentId, subs);

    this.logger.debug(
      { subscriptionId: sub.id, parentAgentId, childFilter: opts.childFilter },
      "subscription created",
    );

    this.schedulePersist();
    return sub;
  }

  unsubscribe(parentAgentId: string, subscriptionId?: string): boolean {
    const subs = this.subscriptions.get(parentAgentId);
    if (!subs) return false;

    if (subscriptionId) {
      const idx = subs.findIndex((s) => s.id === subscriptionId);
      if (idx === -1) return false;
      subs.splice(idx, 1);
      if (subs.length === 0) {
        this.subscriptions.delete(parentAgentId);
      }
      this.logger.debug({ subscriptionId, parentAgentId }, "subscription removed");
      this.schedulePersist();
      return true;
    }

    // Unsubscribe all for this parent
    this.subscriptions.delete(parentAgentId);
    this.logger.debug({ parentAgentId }, "all subscriptions removed");
    this.schedulePersist();
    return true;
  }

  listSubscriptions(parentAgentId: string): Subscription[] {
    return this.subscriptions.get(parentAgentId) ?? [];
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private schedulePersist(): void {
    this.persistQueue = this.persistQueue.then(() => this.persist());
  }

  private async persist(): Promise<void> {
    try {
      const payload: EventStorePayload = {
        events: this.events,
        cursors: Object.fromEntries(this.cursors),
        subscriptions: Array.from(this.subscriptions.values()).flat(),
      };
      await writeJsonFileAtomic(this.filePath, payload);
    } catch (err) {
      this.logger.error({ err }, "Failed to persist event bus");
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;

    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const payload: EventStorePayload = JSON.parse(content);

      this.events = payload.events ?? [];
      this.cursors = new Map(Object.entries(payload.cursors ?? {}));

      // Rebuild subscriptions map
      this.subscriptions.clear();
      for (const sub of payload.subscriptions ?? []) {
        const subs = this.subscriptions.get(sub.parentAgentId) ?? [];
        subs.push(sub);
        this.subscriptions.set(sub.parentAgentId, subs);
      }

      this.loaded = true;
      this.logger.info({ eventCount: this.events.length }, "Event bus loaded");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return;
      }
      this.logger.error({ err }, "Failed to load event bus");
      this.loaded = true;
    }
  }
}
