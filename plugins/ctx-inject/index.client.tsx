import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CtxInjectChip } from "./client/ctx-chip.js";
import {
  CtxInjectChipDataSchema,
  CTX_INJECT_KIND,
  CTX_INJECT_VERSION,
} from "./shared/ctx-schema.js";

export default function contribute(client: PluginClientContext) {
  // The row itself is appended by the server hook at session open; this only
  // teaches the host how to draw it. Paseo validates item.data against the
  // schema before rendering.
  const removeRenderer = client.addTimelineRenderer({
    kind: CTX_INJECT_KIND,
    version: CTX_INJECT_VERSION,
    schema: CtxInjectChipDataSchema,
    Component: CtxInjectChip,
  });
  return () => {
    removeRenderer();
  };
}
