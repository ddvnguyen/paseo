import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Account management contracts. Shapes mirror the adapter CLI's JSON output
 * (packages/freebuff-acp: account-admin.ts, login.ts). Nothing here carries a
 * token, fingerprint or seat instance id.
 */

const accountId = z.string().min(1).max(32);

const seat = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  z.object({ state: z.literal("active"), model: z.string().optional() }),
  z.object({ state: z.literal("unknown") }),
]);

const cliSettings = z.object({
  mode: z.string().optional(),
  freebuffModel: z.string().optional(),
  adsEnabled: z.boolean().optional(),
  freebuffReasoningEfforts: z.record(z.string(), z.string()).optional(),
});

const accountDetail = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean(),
  authenticated: z.boolean(),
  managed: z.boolean(),
  seat,
  status: z
    .object({
      dailyRemaining: z.number().optional(),
      dailyLimit: z.number().optional(),
      resetAt: z.string().optional(),
      walletBalance: z.number().optional(),
    })
    .nullable(),
  cliSettings: cliSettings.nullable(),
});

export const freebuffAccountsList = defineRpc({
  name: "freebuff.accounts.list",
  input: z.object({}),
  output: z.object({ accounts: z.array(accountDetail) }),
});

export const freebuffLoginStart = defineRpc({
  name: "freebuff.login.start",
  input: z.object({ id: accountId, label: z.string().max(80).optional() }),
  output: z.object({ loginUrl: z.string(), expiresAt: z.string() }),
});

export const freebuffLoginPoll = defineRpc({
  name: "freebuff.login.poll",
  input: z.object({ id: accountId }),
  output: z.object({
    status: z.enum(["pending", "expired", "success", "none", "error"]),
    httpStatus: z.number().optional(),
    reason: z.string().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
  }),
});

export const freebuffLoginCancel = defineRpc({
  name: "freebuff.login.cancel",
  input: z.object({ id: accountId }),
  output: z.object({ status: z.literal("cancelled") }),
});

export const freebuffAccountDelete = defineRpc({
  name: "freebuff.account.delete",
  input: z.object({ id: accountId }),
  output: z.object({ removed: z.boolean(), deletedCredentials: z.boolean() }),
});

export const freebuffAccountSetDefault = defineRpc({
  name: "freebuff.account.set-default",
  input: z.object({ id: accountId }),
  output: z.object({ defaultAccountId: z.string() }),
});

export const freebuffAccountRename = defineRpc({
  name: "freebuff.account.rename",
  input: z.object({ id: accountId, label: z.string().max(80) }),
  output: z.object({ id: z.string(), label: z.string() }),
});

export const freebuffSessionEnd = defineRpc({
  name: "freebuff.session.end",
  input: z.object({ id: accountId }),
  output: z.object({ result: z.enum(["ended", "no-session", "unauthenticated", "unknown"]) }),
});
