/**
 * Pure helpers for the Freebuff settings screen. No React, no imports —
 * safe for unit testing and cheap to render.
 */

/** Shape of one account as returned by freebuff.accounts.list. */
export interface AccountDetail {
  id: string;
  label: string;
  isDefault: boolean;
  authenticated: boolean;
  managed: boolean;
  seat: { state: "none" } | { state: "active"; model?: string } | { state: "unknown" };
  status: {
    dailyRemaining?: number;
    dailyLimit?: number;
    resetAt?: string;
    walletBalance?: number;
  } | null;
  cliSettings: CliSettings | null;
}

export interface CliSettings {
  mode?: string;
  freebuffModel?: string;
  adsEnabled?: boolean;
  freebuffReasoningEfforts?: Record<string, string>;
  fallbackToALaCarte?: boolean;
  byokConnected?: boolean;
}

/** Login poll outcome, mirroring the freebuff.login.poll contract. */
export type LoginPollStatus = "pending" | "expired" | "success" | "none" | "error";

export const ACCOUNT_ID_PATTERN = /^[a-z0-9_-]+$/;
export const ACCOUNT_ID_MAX_LENGTH = 32;
export const RESERVED_ACCOUNT_IDS = ["default"] as const;

/** Reasons an id cannot be registered; empty string means valid. */
export function validateAccountId(id: string, existingIds: readonly string[]): string {
  if (id.length === 0) return "Enter an account id.";
  if (id.length > ACCOUNT_ID_MAX_LENGTH) {
    return `Keep the id to ${ACCOUNT_ID_MAX_LENGTH} characters or fewer.`;
  }
  if (!ACCOUNT_ID_PATTERN.test(id)) {
    return "Use lowercase letters, digits, hyphens, or underscores only.";
  }
  if ((RESERVED_ACCOUNT_IDS as readonly string[]).includes(id)) {
    return "That id is reserved.";
  }
  if (existingIds.includes(id)) return "An account with this id already exists.";
  return "";
}

/** True when the id passes every rule in validateAccountId. */
export function isValidAccountId(id: string, existingIds: readonly string[]): boolean {
  return validateAccountId(id, existingIds) === "";
}

/** '20/25 Freebucks left today', falling back to login state. */
export function quotaLine(account: AccountDetail): string {
  if (!account.authenticated) return "Not logged in";
  if (account.status?.dailyRemaining == null) return "Quota unavailable";
  const limit = account.status.dailyLimit ?? "?";
  return `${account.status.dailyRemaining}/${limit} Freebucks left today`;
}

/** Optional '· 3 Freebucks in wallet' suffix. */
export function walletLine(account: AccountDetail): string {
  const balance = account.status?.walletBalance;
  if (balance == null || balance <= 0) return "";
  return ` · ${balance} Freebucks in wallet`;
}

/** 'Session active on MODEL' / 'No active session' / 'Session status unavailable'. */
export function seatLine(account: AccountDetail): string {
  if (account.seat.state === "active") {
    return account.seat.model ? `Session active on ${account.seat.model}` : "Session active";
  }
  if (account.seat.state === "unknown") return "Session status unavailable";
  return "No active session";
}

/** Confirmation body for removing an account; wording depends on how it is stored. */
export function removeAccountMessage(managed: boolean): string {
  if (managed) {
    return "Signs this account out and deletes its stored login on this host.";
  }
  return "Unregisters the account; its Freebuff CLI login folder is kept.";
}

/** Read-only '(value)' or '(not set)' display for a CLI preference. */
export function cliValue(value: string | boolean | undefined): string {
  if (value === undefined) return "not set";
  if (typeof value === "boolean") return value ? "on" : "off";
  return value;
}

/** Reasoning effort configured for one model, e.g. 'gemini-3-pro: high'. */
export function reasoningLine(
  efforts: Record<string, string> | undefined,
  model: string | undefined,
): string | null {
  if (efforts == null) return null;
  if (model != null && efforts[model] != null) {
    return `${model}: ${efforts[model]}`;
  }
  const entries = Object.entries(efforts);
  if (entries.length === 0) return null;
  return entries.map(([key, effort]) => `${key}: ${effort}`).join(", ");
}
