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
  /** Login identity from the stored user record; absent when unknown. */
  email?: string;
  name?: string;
  seat: { state: "none" } | { state: "active"; model?: string } | { state: "unknown" };
  status: {
    dailyRemaining?: number;
    dailyLimit?: number;
    resetAt?: string;
    walletBalance?: number;
  } | null;
  cliSettings: CliSettings | null;
}

/** The account fields the quota helpers read. */
export type QuotaAccount = Pick<AccountDetail, "id" | "label" | "authenticated" | "status">;

export interface CliSettings {
  mode?: string;
  freebuffModel?: string;
  adsEnabled?: boolean;
  freebuffReasoningEfforts?: Record<string, string>;
}

/** Login poll outcome, mirroring the freebuff.login.poll contract. */
export type LoginPollStatus = "pending" | "expired" | "success" | "none" | "error";

/** Max display-label length, enforced by the rename RPC contract too. */
export const ACCOUNT_LABEL_MAX_LENGTH = 80;

/** '20/25 Freebucks left today', falling back to login state. */
export function quotaLine(account: QuotaAccount): string {
  if (!account.authenticated) return "Not logged in";
  const remaining = account.status?.dailyRemaining;
  if (remaining == null) return "Quota unavailable";
  return `${remaining}/${account.status?.dailyLimit ?? "?"} Freebucks left today`;
}

/** '20/25' with the limit blanked when unknown; '—' when not logged in. */
export function quotaRatio(account: QuotaAccount): string {
  if (!account.authenticated) return "—";
  const remaining = account.status?.dailyRemaining;
  if (remaining == null) return "—";
  return `${remaining}/${account.status?.dailyLimit ?? "?"}`;
}

/** 0..100 used today, or null when unknown (no bar). */
export function quotaUsedPercent(account: QuotaAccount): number | null {
  const remaining = account.status?.dailyRemaining;
  const limit = account.status?.dailyLimit;
  if (remaining == null || limit == null || limit <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(((limit - remaining) / limit) * 100)));
}

/**
 * A daily reset timestamp rendered in the viewer's local time, e.g.
 * 'Sep 26, 7:00 AM'. Null when absent or unparseable — never shows raw tokens.
 */
export function formatResetTime(resetAt: string | undefined): string | null {
  if (!resetAt) return null;
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Optional '· 3 Freebucks in wallet' suffix. */
export function walletLine(account: QuotaAccount): string {
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

/** Empty label clears the override; trim before sending. */
export function normalizeRenameLabel(label: string): string {
  return label.trim();
}

/** 'email · name' login identity line; empty when neither is known. */
export function identityLine(account: Pick<AccountDetail, "email" | "name">): string {
  return [account.email?.trim(), account.name?.trim()].filter(Boolean).join(" · ");
}
