import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

import type { freebuffModelsList, freebuffModelsSetEnabled } from "../shared/models";
import { sessionLifetimeLabel } from "../shared/models";
import { runAdapterJson } from "./adapter-cli";

/** One `models list` row as the adapter CLI prints it (see models.ts listModels). */
const adapterModelRow = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string(),
  priceFreebucks: z.number().optional(),
  sessionLengthMs: z.number(),
  priceNotice: z.string().optional(),
  enabled: z.boolean(),
});

/**
 * Catalog models with probe prices and enabled flags, via the adapter CLI
 * (tokens never leave it). Rows are translated to the display contract; when
 * the probe was unreachable no row carries a price and a modelCheck warning
 * says so (the drift diff stays on freebuff.status).
 */
export async function listModels(): Promise<RpcOutput<typeof freebuffModelsList>> {
  const rows = z.array(adapterModelRow).parse(await runAdapterJson<unknown>(["models", "list"]));
  const models = rows.map((row) => {
    const model: RpcOutput<typeof freebuffModelsList>["models"][number] = {
      id: row.id,
      name: row.name,
      tagline: row.tagline,
      sessionLifetimeLabel: sessionLifetimeLabel(row.sessionLengthMs),
      enabled: row.enabled,
    };
    if (row.priceFreebucks !== undefined) model.priceFreebucks = row.priceFreebucks;
    if (row.priceNotice !== undefined) model.priceNotices = row.priceNotice;
    return model;
  });
  const priced = models.some((model) => model.priceFreebucks !== undefined);
  return {
    models,
    ...(priced ? {} : { modelCheck: "Server unreachable; model prices unavailable." }),
  };
}

/**
 * Offer or hide a model for new sessions. The adapter refuses unknown ids
 * and the last enabled model; its stderr line surfaces as the RPC error, so
 * callers get the clean message (never the raw exec failure).
 */
export function setModelEnabled({
  id,
  enabled,
}: RpcInput<typeof freebuffModelsSetEnabled>): Promise<RpcOutput<typeof freebuffModelsSetEnabled>> {
  return runAdapterJson([
    "models",
    "set-enabled",
    "--id",
    id,
    "--enabled",
    enabled ? "true" : "false",
  ]);
}
