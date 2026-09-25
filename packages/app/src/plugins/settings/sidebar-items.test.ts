import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../types";
import { PLUGIN_SETTINGS_SIDEBAR_GROUP, derivePluginSettingsSidebarItems } from "./sidebar-items";

function installed(serverId: string, id = "example"): InstalledPlugin {
  return {
    id,
    cleanup: () => undefined,
    serverId,
    clientBundle: serverId,
    lifetime: new AbortController(),
    queryClient: new QueryClient(),
    settingsScreens: [
      {
        id: "main",
        title: "Freebuff",
        icon: "Wallet",
        Component: () => null,
      },
    ],
    surfaces: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

describe("derivePluginSettingsSidebarItems", () => {
  it("derives one item per settings screen for the selected host", () => {
    const items = derivePluginSettingsSidebarItems(
      [installed("host-a"), installed("host-b")],
      "host-a",
    );

    expect(items).toEqual([
      {
        serverId: "host-a",
        pluginId: "example",
        screenId: "main",
        title: "Freebuff",
        icon: "Wallet",
        key: "plugin-settings-example-main",
      },
    ]);
  });

  it("derives entries for every screen of every running plugin", () => {
    const plugin = installed("host-a");
    const second = {
      ...installed("host-a", "other"),
      settingsScreens: [
        { id: "a", title: "A", icon: "Wallet", Component: () => null },
        { id: "b", title: "B", icon: "Blocks", Component: () => null },
      ],
    };
    const items = derivePluginSettingsSidebarItems([plugin, second], "host-a");

    expect(items.map((item) => item.key)).toEqual([
      "plugin-settings-example-main",
      "plugin-settings-other-a",
      "plugin-settings-other-b",
    ]);
  });

  it("hides entries when the plugin is not running on the selected host", () => {
    expect(derivePluginSettingsSidebarItems([installed("host-a")], "host-b")).toEqual([]);
  });

  it("derives nothing without a selected host", () => {
    expect(derivePluginSettingsSidebarItems([installed("host-a")], null)).toEqual([]);
  });

  it("keeps the host group the entries must sit after", () => {
    expect(PLUGIN_SETTINGS_SIDEBAR_GROUP).toBe("plugins");
  });
});
