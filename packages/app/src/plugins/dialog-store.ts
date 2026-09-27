import { useSyncExternalStore } from "react";

/**
 * Open plugin-panel dialogs, one per workspace. `location: "dialog"` panels
 * render here instead of the workspace tab machinery — a dialog must never
 * become a tab. The workspace screen hosts the view inside AdaptiveModalSheet.
 */

export interface PluginPanelDialogState {
  serverId: string;
  workspaceId: string;
  pluginId: string;
  panelId: string;
  context: "workspace" | "agent";
  agentId?: string;
}

let current: PluginPanelDialogState | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function openPluginPanelDialog(state: PluginPanelDialogState): void {
  if (!state.workspaceId.trim()) throw new Error("Plugin dialog needs a workspace");
  current = state;
  emit();
}

export function closePluginPanelDialog(): void {
  current = null;
  emit();
}

export function getPluginPanelDialogSnapshot(): PluginPanelDialogState | null {
  return current;
}

export function subscribePluginPanelDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePluginPanelDialog(): PluginPanelDialogState | null {
  return useSyncExternalStore(subscribePluginPanelDialog, getPluginPanelDialogSnapshot);
}
