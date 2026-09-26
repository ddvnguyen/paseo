import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentUsage, AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { createRecorder, type Recorder } from "./recorder.js";
import { createNodeStore } from "./node-store.js";
import type { TrajectoryStore } from "./store.js";

/**
 * Daemon-side wiring: one recorder + store for the plugin process, attached
 * lazily and idempotently to the daemon's agent streams.
 *
 * Reference bug 2 fixed by design: the PaseoApi only exists inside hook/RPC
 * contexts, so `ensureAttached` is called at the top of every hook callback
 * and RPC handler; the first call attaches once, later calls are no-ops.
 */

/** Documented plugin data directory is none; use the Paseo home layout. */
export function defaultDbPath(): string {
  const base = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(base, "trajectory", "events.db");
}

export function openDefaultStore(): TrajectoryStore {
  const path = defaultDbPath();
  mkdirSync(join(path, ".."), { recursive: true });
  return createNodeStore(path);
}

/** Minimal structural PaseoApi surface the wiring uses; fakes in tests. */
export interface PaseoLike {
  agents: {
    list(options: { subscribe: {} }): Promise<{
      entries: Array<{ agent: { id: string; provider: string } }>;
      subscription: {
        subscribe(handlers: {
          snapshot(input: { entries: Array<{ agent: { id: string; provider: string } }> }): void;
          update(message: {
            type: string;
            payload:
              | { kind: "upsert"; agent: { id: string; provider: string } }
              | { kind: "remove"; agentId: string };
          }): void;
        }): void;
        release(): Promise<void> | void;
      };
    }>;
    ref(agentId: string): {
      timeline: {
        subscribe(
          handler: (update: {
            event:
              | { type: "timeline"; item: AgentTimelineItem; turnId?: string }
              | { type: "usage_updated"; usage: AgentUsage; turnId?: string }
              | { type: "turn_completed"; usage?: AgentUsage; turnId?: string }
              | { type: "turn_failed"; error: string; usage?: AgentUsage; turnId?: string }
              | { type: "turn_canceled"; reason: string; usage?: AgentUsage; turnId?: string }
              | { type: string };
          }) => void,
        ): { ready: Promise<void>; release(): void };
      };
    };
  };
}

interface AgentSub {
  release(): void;
  ready: Promise<void>;
}

export interface Wiring {
  recorder: Recorder;
  store: TrajectoryStore;
  /** Idempotent: attaches the directory + timeline subscriptions once. */
  ensureAttached(paseo: PaseoLike): void;
  /** True after the first successful ensureAttached call. */
  readonly attached: boolean;
  /** Runs all disposers (subscriptions), then closes the store. */
  cleanup(): Promise<void>;
}

export function createWiring(options: { store: TrajectoryStore }): Wiring {
  const store = options.store;
  const recorder = createRecorder({ store });

  let attachStarted = false;
  let cleanedUp = false;
  const disposers: Array<() => void> = [];
  /** agentId -> timeline subscription for that agent. */
  const agentSubs = new Map<string, AgentSub>();

  const handleStreamEvent = (
    agentId: string,
    event: { type: string } & Record<string, unknown>,
  ): void => {
    switch (event.type) {
      case "timeline":
        if (event.item) {
          recorder.timelineItem({
            agentId,
            turnId: (event.turnId as string | undefined) ?? null,
            item: event.item as AgentTimelineItem,
          });
        }
        break;
      case "usage_updated":
        if (event.usage) {
          recorder.usage({
            agentId,
            turnId: (event.turnId as string | undefined) ?? null,
            usage: event.usage as AgentUsage,
          });
        }
        break;
      case "turn_completed":
        if (event.usage) {
          recorder.usage({
            agentId,
            turnId: (event.turnId as string | undefined) ?? null,
            usage: event.usage as AgentUsage,
          });
        }
        recorder.turnEnded({
          agentId,
          turnId: (event.turnId as string | undefined) ?? null,
          outcome: "completed",
        });
        break;
      case "turn_failed":
        if (event.usage) {
          recorder.usage({
            agentId,
            turnId: (event.turnId as string | undefined) ?? null,
            usage: event.usage as AgentUsage,
          });
        }
        recorder.turnEnded({
          agentId,
          turnId: (event.turnId as string | undefined) ?? null,
          outcome: "failed",
          error: typeof event.error === "string" ? event.error : null,
        });
        break;
      case "turn_canceled":
        if (event.usage) {
          recorder.usage({
            agentId,
            turnId: (event.turnId as string | undefined) ?? null,
            usage: event.usage as AgentUsage,
          });
        }
        recorder.turnEnded({
          agentId,
          turnId: (event.turnId as string | undefined) ?? null,
          outcome: "canceled",
        });
        break;
      default:
        // subscription_restored / replacement / error / permission_* etc: not ledger facts.
        break;
    }
  };

  const attachAgent = (agentId: string): void => {
    if (agentSubs.has(agentId) || cleanedUp) return;
    try {
      const sub = paseoRefTimeline(agentId);
      if (!sub) return;
      agentSubs.set(agentId, sub);
      void sub.ready.catch((error: unknown) => {
        console.error("[trajectory] timeline subscribe failed", agentId, error);
        agentSubs.delete(agentId);
      });
    } catch (error) {
      console.error("[trajectory] attach failed", agentId, error);
    }
  };

  let currentPaseo: PaseoLike | undefined;

  const paseoRefTimeline = (agentId: string): AgentSub | null => {
    if (!currentPaseo) return null;
    try {
      const sub = currentPaseo.agents.ref(agentId).timeline.subscribe((update) => {
        handleStreamEvent(agentId, update.event as { type: string } & Record<string, unknown>);
      });
      return { ready: sub.ready, release: () => sub.release() };
    } catch (error) {
      console.error("[trajectory] timeline.subscribe threw", agentId, error);
      return null;
    }
  };

  const detachAgent = (agentId: string): void => {
    const sub = agentSubs.get(agentId);
    if (!sub) return;
    agentSubs.delete(agentId);
    try {
      sub.release();
    } catch {
      // already released
    }
  };

  const ensureAttached = (paseo: PaseoLike): void => {
    if (attachStarted || cleanedUp) return;
    attachStarted = true;
    currentPaseo = paseo as PaseoLike;
    void paseo.agents
      .list({ subscribe: {} })
      .then((directory) => {
        if (cleanedUp) {
          void directory.subscription.release();
          return undefined;
        }
        disposers.push(() => {
          void directory.subscription.release();
        });
        directory.subscription.subscribe({
          snapshot({ entries }) {
            for (const { agent } of entries) attachAgent(agent.id);
          },
          update(message) {
            if (message.type !== "agent_update") return;
            if (message.payload.kind === "upsert") {
              attachAgent(message.payload.agent.id);
            } else {
              detachAgent(message.payload.agentId);
            }
          },
        });
        // Snapshot then updates; attach to whatever is live now.
        for (const { agent } of directory.entries) attachAgent(agent.id);
        return undefined;
      })
      .catch((error) => {
        console.error("[trajectory] agents.list(subscribe) failed", error);
        // Allow a later hook/RPC call to retry the attach.
        attachStarted = false;
        currentPaseo = undefined;
        return undefined;
      });
  };

  return {
    recorder,
    store,
    get attached() {
      return attachStarted;
    },
    ensureAttached,
    async cleanup() {
      cleanedUp = true;
      for (const dispose of disposers.splice(0, disposers.length)) dispose();
      for (const agentId of Array.from(agentSubs.keys())) detachAgent(agentId);
      store.close();
    },
  };
}
