import type { PluginClientContext } from "@getpaseo/plugin/client";

import { FreebuffSettings } from "./client/settings-screen";
import { FreebuffSurface } from "./client/surface";

export default function contribute(client: PluginClientContext) {
  client.addSurface("freebuff", FreebuffSurface);
  client.addSidebarItem({
    id: "freebuff",
    title: "Freebuff",
    icon: "Wallet",
    surface: "freebuff",
  });
  client.addSettingsScreen({
    id: "freebuff",
    title: "Freebuff",
    icon: "Wallet",
    Component: FreebuffSettings,
  });
  return () => {};
}
