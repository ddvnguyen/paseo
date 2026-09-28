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
            onPress() {
              client.openPanel("trajectory", { workspaceId, location: "dialog" });
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
