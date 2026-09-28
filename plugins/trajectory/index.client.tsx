import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TrajectoryPanel } from "./client/trajectory-panel.js";
import { registerTrajectoryHeaderButton } from "./client/trajectory-header-button.js";

export default function contribute(client: PluginClientContext) {
  // Agent trajectory ledger as a dialog overlay (location:"dialog" mounts in
  // the workspace-screen PluginPanelDialogHost). Header buttons are
  // workspace-scoped only, so the agent-context entry point is the Command
  // Center item below; workspace/agent ids are implicit in that context.
  const removePanel = client.addWorkspacePanel({
    id: "trajectory",
    title: "Trajectory",
    icon: "PanelTop",
    locations: ["dialog"],
    context: "agent",
    Component: TrajectoryPanel,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "trajectory-open",
    title: "Open trajectory",
    icon: "PanelTop",
    keywords: ["trajectory", "ledger", "turns", "tools"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("trajectory", { location: "dialog" });
    },
  });
  // Workspace top-bar entry point. The panel auto-selects the workspace's first
  // agent, so this opens without an agentId.
  const removeHeaderButton = registerTrajectoryHeaderButton(client);
  return () => {
    removeCommand();
    removeHeaderButton();
    removePanel();
  };
}
