import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Model catalog contracts. Rows mirror the adapter CLI's `models list` JSON
 * (packages/freebuff-acp: models.ts listModels) translated for display:
 * sessionLengthMs becomes a human label, the per-model price note keeps the
 * probe's `priceNotices` name. Nothing here carries a token.
 */

const modelRow = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string(),
  /** Cost to open a session, from the status probe; absent when unknown. */
  priceFreebucks: z.number().optional(),
  /** Fresh-seat lifetime, e.g. "1h". */
  sessionLifetimeLabel: z.string(),
  /** Server note on this model's price (peak/off-peak, trials); absent when none. */
  priceNotices: z.string().optional(),
  enabled: z.boolean(),
});

/** Fresh-seat milliseconds rendered as "1h", whole minutes as "1m", else raw ms. */
export function sessionLifetimeLabel(sessionLengthMs: number): string {
  if (sessionLengthMs >= 3_600_000 && Number.isInteger(sessionLengthMs / 3_600_000)) {
    return `${sessionLengthMs / 3_600_000}h`;
  }
  if (sessionLengthMs >= 60_000 && Number.isInteger(sessionLengthMs / 60_000)) {
    return `${sessionLengthMs / 60_000}m`;
  }
  return `${sessionLengthMs}ms`;
}

export const freebuffModelsList = defineRpc({
  name: "freebuff.models.list",
  input: z.object({}),
  output: z.object({
    models: z.array(modelRow),
    /** Present when the model data is degraded (e.g. probe unreachable, no prices). */
    modelCheck: z.string().optional(),
  }),
});

export const freebuffModelsSetEnabled = defineRpc({
  name: "freebuff.models.set-enabled",
  input: z.object({ id: z.string().min(1), enabled: z.boolean() }),
  output: z.object({ disabled: z.array(z.string()) }),
});
