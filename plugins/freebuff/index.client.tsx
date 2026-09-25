import type { PluginClientContext } from "@getpaseo/plugin/client";

import { FreebuffSurface } from "./client/surface";

export default function contribute(client: PluginClientContext) {
  client.addSurface("freebuff", FreebuffSurface);
  client.addSidebarItem({
    id: "freebuff",
    title: "Freebuff",
    icon: "Wallet",
    surface: "freebuff",
  });
  return () => {};
}
