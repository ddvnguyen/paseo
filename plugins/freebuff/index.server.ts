import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

import { ADAPTER_ENTRY } from "./server/generated";
import { readFreebuffStatus } from "./server/status";
import { freebuffStatus } from "./shared/status";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(
    runAcpProvider({
      id: "freebuff",
      label: "Freebuff",
      description: "Free coding models via Freebuff, with multi-account quota",
      icon: "icon.svg",
      command: [process.execPath, ADAPTER_ENTRY],
    }),
  );
  server.handle(freebuffStatus, readFreebuffStatus);
  return () => {};
}
