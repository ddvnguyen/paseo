import type { ModelInfo, SessionConfigOption } from "@agentclientprotocol/sdk";

import { probeOpenSession } from "./freebuff-session.js";

/**
 * Account identity + quota, surfaced to the host as ACP session config
 * options. Hosts with a generic "features" surface (Paseo) render select
 * config options, so the read-only account line and the confirm-before-open
 * switch both ride that channel.
 */

export const ACCOUNT_CONFIG_ID = "account";
export const CONFIRM_OPEN_CONFIG_ID = "confirm_open";
export const MODEL_CONFIG_ID = "model";

export type ConfirmOpenMode = "ask" | "auto";

export interface AccountStatus {
  dailyRemaining?: number;
  dailyLimit?: number;
  resetAt?: string;
  walletBalance?: number;
  prices: Record<string, number>;
  priceNotices: Record<string, string>;
}

const STATUS_TIMEOUT_MS = 4000;

/** Quota/prices from the server; null when it cannot be reached in time. */
export async function fetchAccountStatus(token: string): Promise<AccountStatus | null> {
  const probe = await probeOpenSession(token, AbortSignal.timeout(STATUS_TIMEOUT_MS));
  const freebucks = probe?.freebucks;
  if (!freebucks) return null;
  return {
    dailyRemaining: freebucks.daily?.remaining,
    dailyLimit: freebucks.daily?.limit,
    resetAt: freebucks.daily?.resetAt,
    walletBalance: freebucks.wallet?.balance,
    prices: freebucks.prices ?? {},
    priceNotices: freebucks.priceNotices ?? {},
  };
}

/** One line: "Duc Nguyen · 20/25 Freebucks left today · wallet 3". */
export function formatAccountSummary(accountName: string, status: AccountStatus | null): string {
  const parts = [accountName];
  if (status?.dailyRemaining != null) {
    parts.push(
      status.dailyLimit != null
        ? `${status.dailyRemaining}/${status.dailyLimit} Freebucks left today`
        : `${status.dailyRemaining} Freebucks left today`,
    );
  }
  if (status?.walletBalance) parts.push(`wallet ${status.walletBalance}`);
  return parts.join(" · ");
}

export function initialConfirmOpenMode(env: NodeJS.ProcessEnv): ConfirmOpenMode {
  return env.FREEBUFF_CONFIRM_OPEN?.trim().toLowerCase() === "auto" ? "auto" : "ask";
}

export function isConfirmOpenMode(value: string): value is ConfirmOpenMode {
  return value === "ask" || value === "auto";
}

export function buildConfigOptions(input: {
  accountName: string;
  status: AccountStatus | null;
  confirmOpen: ConfirmOpenMode;
  /**
   * Model picker as a `model`-category config option, for hosts that build
   * their catalog from config options rather than ACP's `models` state.
   */
  models?: { currentModelId: string; availableModels: ModelInfo[] };
}): SessionConfigOption[] {
  const summary = formatAccountSummary(input.accountName, input.status);
  const resetNote = input.status?.resetAt
    ? `Daily Freebucks reset at ${input.status.resetAt}.`
    : undefined;
  const modelOption = input.models
    ? [
        {
          id: MODEL_CONFIG_ID,
          name: "Model",
          category: "model",
          type: "select",
          currentValue: input.models.currentModelId,
          options: input.models.availableModels.map((model) => ({
            value: model.modelId,
            name: model.name,
            ...(model.description ? { description: model.description } : {}),
          })),
        },
      ]
    : [];
  return [
    ...modelOption,
    {
      id: ACCOUNT_CONFIG_ID,
      name: "Account",
      description: resetNote ?? "Freebuff account and remaining Freebucks.",
      type: "select",
      currentValue: "current",
      options: [{ value: "current", name: summary }],
    },
    {
      id: CONFIRM_OPEN_CONFIG_ID,
      name: "Session open",
      description: "Whether a new (credit-spending) free session needs your approval first.",
      type: "select",
      currentValue: input.confirmOpen,
      options: [
        { value: "ask", name: "Ask before opening" },
        { value: "auto", name: "Open automatically" },
      ],
    },
  ] as SessionConfigOption[];
}
