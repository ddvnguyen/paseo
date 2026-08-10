import type { Logger } from "pino";

import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";

/**
 * Reaps idle agent provider sessions so agents don't hold their opencode serve
 * REPL process (and the MCP stack it owns) resident in memory forever.
 *
 * Mirrors the workspace-watcher lease pattern: every interest signal re-arms a
 * per-agent one-shot timer. When the timer expires the agent is demoted to
 * "cold" — its provider session is closed (freeing its processes) but the agent
 * stays registered and listed as "idle", and any later activation lazily
 * resumes it via ensureAgentLoaded -> resumeAgentFromPersistence.
 *
 * The daemon owns exactly one subscription to agent-manager events; client
 * viewing is accounted for by a viewer checker injected once the websocket
 * server exists, so an agent a client is actively viewing is never reaped.
 */
export interface AgentSessionIdleService {
  /** Re-arm the idle lease for an agent (activity or explicit client interest). */
  touch(agentId: string): void;
  /** Feed agent-manager events; arms/re-arms leases on agent activity. */
  handleAgentEvent(event: AgentManagerEvent): void;
  /**
   * Replace the viewer checker. Called once the websocket server exists so the
   * service can ask "is any client actively viewing this agent?" at expiry.
   */
  setViewerChecker(checker: (agentId: string) => boolean): void;
  dispose(): void;
}

export interface AgentSessionIdleServiceDeps {
  agentManager: Pick<AgentManager, "getAgent" | "demoteIdleAgentToCold">;
  /** Idle timeout in ms before an idle session is reaped. 0 disables reaping. */
  timeoutMs: number;
  logger: Logger;
}

export function createAgentSessionIdleService(
  deps: AgentSessionIdleServiceDeps,
): AgentSessionIdleService {
  const { agentManager, timeoutMs, logger } = deps;
  const timers = new Map<string, NodeJS.Timeout>();
  let viewerChecker: ((agentId: string) => boolean) | null = null;

  function clearTimer(agentId: string): void {
    const timer = timers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(agentId);
    }
  }

  function armTimer(agentId: string): void {
    clearTimer(agentId);
    if (timeoutMs <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(agentId);
      void onExpire(agentId);
    }, timeoutMs);
    // Do not hold the daemon's event loop open solely for reap timers.
    timer.unref();
    timers.set(agentId, timer);
  }

  async function onExpire(agentId: string): Promise<void> {
    const agent = agentManager.getAgent(agentId);
    if (!agent || agent.cold) {
      // Already demoted or gone; nothing left to reap.
      return;
    }
    if (agent.lifecycle !== "idle" || agent.activeForegroundTurnId !== null) {
      // Active; its own activity events re-arm the lease.
      return;
    }
    if (viewerChecker?.(agentId)) {
      // A client is actively viewing this agent; re-check after another full
      // timeout so we reap it once the viewer leaves instead of skipping once.
      armTimer(agentId);
      return;
    }
    logger.info({ agentId, provider: agent.provider }, "agent.idle-reap.demoting");
    const demoted = await agentManager.demoteIdleAgentToCold(agentId, {
      keepWarm: () => viewerChecker?.(agentId) ?? false,
    });
    if (!demoted) {
      logger.trace({ agentId }, "agent.idle-reap.skipped");
      // Became busy between the check and the demote; retry after a full timeout.
      armTimer(agentId);
    }
  }

  function handleAgentEvent(event: AgentManagerEvent): void {
    if (event.type === "agent_state") {
      const agent = event.agent;
      if (agent.cold) {
        return;
      }
      // Any lifecycle transition is activity: freshly resumed agents (idle)
      // start the countdown, and running/active agents keep it re-armed.
      if (agent.lifecycle === "running" || agent.activeForegroundTurnId !== null) {
        touch(agent.id);
      } else if (agent.lifecycle === "idle") {
        touch(agent.id);
      }
      return;
    }
    if (event.type === "agent_stream" && event.event.type === "turn_started") {
      touch(event.agentId);
    }
  }

  function touch(agentId: string): void {
    armTimer(agentId);
  }

  return {
    touch,
    handleAgentEvent,
    setViewerChecker(checker: (agentId: string) => boolean): void {
      viewerChecker = checker;
    },
    dispose(): void {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}
