import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inputSchema } from "./shared/input.js";
import { fetchUsage, discover } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource({
    id: "freebuff",
    label: "Freebuff",
    icon: "icon.svg",
    input: inputSchema,
    discover: (scope) => (scope.kind === "global" ? discover(scope) : Promise.resolve([])),
    fetch: fetchUsage,
  });
  return () => {};
}
