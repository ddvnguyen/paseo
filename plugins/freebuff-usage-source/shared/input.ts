import { z } from "zod";

/**
 * Freebuff has no per-account login to discover: the deployed adapter CLI reports
 * every account it knows about in one `status` call. The input is therefore just
 * where that CLI lives, so the daemon never learns a credential.
 */
export const inputSchema = z
  .object({
    cliPath: z.string().min(1),
  })
  .strict();

export type UsageInput = z.infer<typeof inputSchema>;