import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

/**
 * Workspace top-bar button that opens the trajectory panel full-screen.
 *
 * Header buttons are addressed by workspace, and the host stores one entry per
 * (plugin, placement, id, workspace) — registering twice for the same workspace
 * throws, so a workspace gets exactly one button and re-upserts are ignored. The
 * workspace directory is therefore followed with an owned subscription, and the
 * button set is reconciled against each snapshot.
 *
 * The panel is opened WITHOUT an agentId on purpose: `TrajectoryPanel` accepts a
 * workspace-context open and selects that workspace's first agent itself, so the
 * header button works before any agent is picked.
 */

export const TRAJECTORY_HEADER_BUTTON_ID = "trajectory-open";

/** Ranking preference: whatever the user is looking at beats whatever is idle. */
const STATUS_RANK: Record<string, number> = { running: 0, initializing: 1, idle: 2, error: 3 };

/**
 * Pick the workspace's agent to show: most recently active first, with a running
 * agent preferred over an idle one. Resolved at press time rather than cached, so
 * the button can never open a stale or archived agent.
 */
export async function pickAgentForWorkspace(
  client: PluginClientContext,
  workspaceId: string,
): Promise<string> {
  const { entries } = await client.paseo.agents.list();
  const candidates = entries
    .map((entry) => entry.agent)
    .filter((agent) => agent.workspaceId === workspaceId);
  const best = candidates.reduce<(typeof candidates)[number] | null>((winner, agent) => {
    if (winner === null) return agent;
    const byStatus = (STATUS_RANK[agent.status] ?? 9) - (STATUS_RANK[winner.status] ?? 9);
    if (byStatus !== 0) return byStatus < 0 ? agent : winner;
    return recency(agent) > recency(winner) ? agent : winner;
  }, null);
  if (best === null) {
    throw new Error(`No agent in workspace ${workspaceId} to open a trajectory for`);
  }
  return best.id;
}

function recency(agent: { updatedAt: string; lastUserMessageAt?: string | null }): number {
  return Date.parse(agent.lastUserMessageAt ?? agent.updatedAt) || 0;
}

export function registerTrajectoryHeaderButton(client: PluginClientContext): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
  let stopped = false;

  const register = (workspaceId: string): void => {
    if (stopped || !workspaceId || buttons.has(workspaceId)) return;
    buttons.set(
      workspaceId,
      client.addHeaderButton({
        id: TRAJECTORY_HEADER_BUTTON_ID,
        workspaceId,
        button: {
          title: "Open trajectory",
          icon: "ListTree",
          behavior: {
            kind: "action",
            async onPress() {
              const agentId = await pickAgentForWorkspace(client, workspaceId);
              // The panel is registered agent-context, and the host's
              // workspace-context openPanel only resolves `context: "workspace"`
              // panels — opening without an agentId throws and the button does
              // nothing. So resolve the agent here and take the agent path, which
              // is the same path the Command Center item uses and therefore
              // shows the same trajectory.
              client.openPanel("trajectory", { workspaceId, agentId, location: "dialog" });
            },
          },
        },
      }),
    );
  };

  const drop = (workspaceId: string): void => {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  };

  const reconcile = (workspaceIds: readonly string[]): void => {
    const next = new Set(workspaceIds.filter((id) => id.length > 0));
    for (const registered of buttons.keys()) {
      if (!next.has(registered)) drop(registered);
    }
    for (const workspaceId of next) register(workspaceId);
  };

  // `workspaces.list` takes no `signal` (unlike `agents.list`), so bootstrap is
  // guarded by the `stopped` flag instead: a snapshot that arrives after cleanup
  // releases the subscription rather than registering buttons for a dead plugin.
  void client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (stopped) {
        void subscription.release();
        return undefined;
      }
      subscription.subscribe({
        snapshot: ({ entries }) => reconcile(entries.map((entry) => entry.id)),
        update: (message) => {
          if (message.type !== "workspace_update") return;
          if (message.payload.kind === "upsert") register(message.payload.workspace.id);
          else drop(message.payload.id);
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) {
        console.error("[trajectory] header button observation failed", error);
      }
    });

  return () => {
    stopped = true;
    for (const button of buttons.values()) button.remove();
    buttons.clear();
  };
}
