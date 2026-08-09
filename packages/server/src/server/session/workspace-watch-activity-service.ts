import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";

/**
 * Tracks watch interest for the workspace-git service so live working-tree
 * watchers are only kept for workspaces that are actually being used: an agent
 * is running, a foreground turn started, or a client is viewing it.
 *
 * Every interest signal re-arms a per-workspace idle timer inside the
 * workspace-git service (WORKSPACE_WATCH_IDLE_TTL_MS). Idle workspaces with no
 * interest degrade to a slow bounded poll instead of holding a native
 * @parcel/watcher subscription, which at scale avoids the watcher churn that
 * wedges the daemon's event loop.
 */
export interface WorkspaceWatchActivityService {
  /** Declare a workspace as currently viewed by a client (re-arms interest). */
  touchCwd(cwd: string): void;
  /**
   * Feed an agent-manager event into the activity tracker. The session owns
   * the AgentManager subscription (so there is exactly one global listener)
   * and forwards every event here.
   */
  handleAgentEvent(event: AgentManagerEvent): void;
  dispose(): void;
}

export interface WorkspaceWatchActivityServiceDeps {
  agentManager: AgentManager;
  workspaceGitService: WorkspaceGitService;
  now?: () => Date;
}

export function createWorkspaceWatchActivityService(
  deps: WorkspaceWatchActivityServiceDeps,
): WorkspaceWatchActivityService {
  const { agentManager, workspaceGitService } = deps;
  const now = deps.now ?? (() => new Date());

  function handleAgentEvent(event: AgentManagerEvent): void {
    if (event.type === "agent_state") {
      const agent = event.agent;
      if (agent.lifecycle === "running" || agent.activeForegroundTurnId !== null) {
        workspaceGitService.touchWorkspaceWatch(agent.cwd);
      }
      return;
    }
    if (event.type === "agent_stream" && event.event.type === "turn_started") {
      const agent = agentManager.getAgent(event.agentId);
      if (agent) {
        workspaceGitService.touchWorkspaceWatch(agent.cwd);
      }
    }
  }

  return {
    touchCwd(cwd: string): void {
      void now;
      workspaceGitService.touchWorkspaceWatch(cwd);
    },
    handleAgentEvent,
    dispose(): void {
      // Nothing to dispose: the tracker holds no subscriptions or timers of
      // its own (the session owns the AgentManager subscription and forwards
      // every event here, and a running agent's ongoing events keep the
      // workspace-git idle lease re-armed).
    },
  };
}
