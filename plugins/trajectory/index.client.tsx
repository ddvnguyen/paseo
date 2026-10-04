import type { PluginClientContext } from "@getpaseo/plugin/client";
import { TrajectoryPanel } from "./client/trajectory-panel.js";
import { registerTrajectoryHeaderButton } from "./client/trajectory-header-button.js";

export default function contribute(client: PluginClientContext) {
  // Agent trajectory ledger as a dialog overlay (location:"dialog" mounts in
  // the workspace-screen PluginPanelDialogHost). Registered agent-context, so
  // the Command Center item below is the direct entry point and the header
  // button resolves an agent for its workspace before opening the same panel.
  const removePanel = client.addWorkspacePanel({
    id: "trajectory",
    title: "Trajectory",
    icon: "PanelTop",
    locations: ["dialog"],
    context: "agent",
    // The ledger is a dense table with a gantt strip and a toolbar; a
    // content-sized modal gives it no room. Declared on the contribution so the
    // header button and the Command Center item both get the same presentation.
    fullScreen: true,
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
  // Workspace top-bar entry point. It resolves the workspace's agent at press
  // time and opens through the agent path, because the host's workspace-context
  // openPanel only resolves `context: "workspace"` panels.
  const removeHeaderButton = registerTrajectoryHeaderButton(client);
  return () => {
    removeCommand();
    removeHeaderButton();
    removePanel();
  };
}
