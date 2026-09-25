import type { InstalledPlugin } from "../types";

/**
 * Host sections the plugin settings entries must sit after. The sidebar appends
 * them right below the Plugins row inside the same host group.
 */
export const PLUGIN_SETTINGS_SIDEBAR_GROUP = "plugins" as const;

export interface PluginSettingsSidebarItem {
  /** Route identity for the settings screen. */
  serverId: string;
  pluginId: string;
  screenId: string;
  /** Registration metadata for label and icon. */
  title: string;
  /** Lucide icon name from the registration; the view resolves the component. */
  icon: string;
  /** Stable React key and test id. */
  key: string;
}

/**
 * Derives the settings-sidebar entries for one host's running plugins. Only
 * installed (running) plugins contribute, so disable, remove, disconnect, and
 * catalog changes hide the entries automatically; the registry is the single
 * source of truth.
 *
 * The screen id is unique within an installation, so entries stay host-scoped
 * instead of being coalesced across hosts like sidebar contributions: each
 * installation opens its own route.
 */
export function derivePluginSettingsSidebarItems(
  plugins: readonly InstalledPlugin[],
  serverId: string | null,
): PluginSettingsSidebarItem[] {
  if (!serverId) return [];
  return plugins.flatMap((plugin) => {
    if (plugin.serverId !== serverId) return [];
    return plugin.settingsScreens.map((screen) => ({
      serverId,
      pluginId: plugin.id,
      screenId: screen.id,
      title: screen.title,
      icon: screen.icon,
      key: `plugin-settings-${plugin.id}-${screen.id}`,
    }));
  });
}
