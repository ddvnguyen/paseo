import type { PluginClientContext } from "@getpaseo/plugin/client";

import { FreebuffSettings } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "freebuff",
    title: "Freebuff",
    icon: "Wallet",
    Component: FreebuffSettings,
  });
  return () => {};
}
