import type { PluginServerContext } from "@getpaseo/plugin/server";

export default function contribute(_server: PluginServerContext) {
  // Recorder + RPCs land in T0/T1.
  return () => {};
}
