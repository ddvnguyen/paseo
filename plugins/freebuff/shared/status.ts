import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const accountStatus = z.object({
  dailyRemaining: z.number().optional(),
  dailyLimit: z.number().optional(),
  resetAt: z.string().optional(),
  walletBalance: z.number().optional(),
  prices: z.record(z.string(), z.number()),
});

export const freebuffStatus = defineRpc({
  name: "freebuff.status",
  input: z.object({}),
  output: z.object({
    accounts: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        authenticated: z.boolean(),
        status: accountStatus.nullable(),
      }),
    ),
    modelCheck: z.object({
      checked: z.boolean(),
      missingInAdapter: z.array(z.string()),
      missingOnServer: z.array(z.string()),
    }),
  }),
});
