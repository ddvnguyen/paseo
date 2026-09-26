import fs from "node:fs";
import path from "node:path";

import { type AccountStatus, accountStatusFromProbe } from "./account.js";
import {
  accountConfigDir,
  accountDisplayName,
  credentialsForAccount,
  findAccount,
  isValidAccountId,
  listAccounts,
  listAccountsOrdered,
  removeAccount,
  renameAccount,
  reorderAccounts,
  resolveDefaultAccountId,
  setDefaultAccount,
  type FreebuffAccount,
} from "./accounts.js";
import { getCredentialsPath } from "./auth.js";
import { probeSessionSeat, releaseFreebuffSession } from "./freebuff-session.js";

/**
 * Read/manage view of the registered accounts for the settings UI. Every
 * shape here is safe to send over the daemon RPC: tokens, fingerprints and
 * instance ids never leave this module.
 */

const PROBE_TIMEOUT_MS = 6000;

/** Whether the account holds a Freebuff seat right now (`unknown` = the probe failed). */
export type SeatState =
  | { state: "none" }
  | { state: "active"; model?: string }
  | { state: "unknown" };

/**
 * The Freebuff CLI's own preferences for the account (its `settings.json`).
 * Read-only: the adapter takes model, mode and reasoning from the Paseo agent
 * config, so these values do not change how Paseo agents behave.
 */
export interface CliSettingsView {
  mode?: string;
  freebuffModel?: string;
  adsEnabled?: boolean;
  freebuffReasoningEfforts?: Record<string, string>;
}

export interface AccountDetail {
  id: string;
  label: string;
  isDefault: boolean;
  authenticated: boolean;
  /** Adapter-managed (created by login-start); false for a `freebuff login` dir. */
  managed: boolean;
  /**
   * Login identity from the stored user record (`default` profile of the
   * account's credentials.json). Absent when no record exists (e.g. env-key
   * auth) — there is no per-account user-info endpoint to fall back to, so
   * these stay unknown rather than guessed. Never tokens.
   */
  email?: string;
  name?: string;
  seat: SeatState;
  status: AccountStatus | null;
  cliSettings: CliSettingsView | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Parse a CLI `settings.json` body into the read-only view (unknown keys dropped). */
export function cliSettingsFromJson(raw: unknown): CliSettingsView {
  if (!isRecord(raw)) return {};
  const view: CliSettingsView = {};
  if (typeof raw.mode === "string") view.mode = raw.mode;
  if (typeof raw.freebuffModel === "string") view.freebuffModel = raw.freebuffModel;
  if (typeof raw.adsEnabled === "boolean") view.adsEnabled = raw.adsEnabled;
  const efforts = stringRecord(raw.freebuffReasoningEfforts);
  if (efforts) view.freebuffReasoningEfforts = efforts;
  return view;
}

/** The CLI settings for one account; null when it has no settings file. */
function readCliSettings(account: FreebuffAccount, env: NodeJS.ProcessEnv): CliSettingsView | null {
  const scoped =
    account.configDir === null ? env : { ...env, FREEBUFF_CONFIG_DIR: account.configDir };
  const credentialsPath = getCredentialsPath(scoped);
  if (!credentialsPath) return null;
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(path.dirname(credentialsPath), "settings.json"), "utf8"),
    );
    return cliSettingsFromJson(raw);
  } catch {
    return null;
  }
}

function isManaged(account: FreebuffAccount, env: NodeJS.ProcessEnv): boolean {
  return account.configDir !== null && account.configDir === accountConfigDir(account.id, env);
}

/** Display identity from the account's stored login user record (never tokens). */
function readStoredIdentity(
  account: FreebuffAccount,
  env: NodeJS.ProcessEnv,
): { email?: string; name?: string } {
  const scoped =
    account.configDir === null ? env : { ...env, FREEBUFF_CONFIG_DIR: account.configDir };
  const credentialsPath = getCredentialsPath(scoped);
  if (!credentialsPath) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.default)) return {};
    const identity: { email?: string; name?: string } = {};
    if (typeof parsed.default.email === "string" && parsed.default.email.trim()) {
      identity.email = parsed.default.email.trim();
    }
    if (typeof parsed.default.name === "string" && parsed.default.name.trim()) {
      identity.name = parsed.default.name.trim();
    }
    return identity;
  } catch {
    return {};
  }
}

async function describeAccount(
  account: FreebuffAccount,
  env: NodeJS.ProcessEnv,
): Promise<AccountDetail> {
  const credentials = credentialsForAccount(account, env);
  const identity = readStoredIdentity(account, env);
  const base = {
    id: account.id,
    label: accountDisplayName(account, env),
    isDefault: account.id === resolveDefaultAccountId(env),
    authenticated: credentials !== null,
    managed: isManaged(account, env),
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.name ? { name: identity.name } : {}),
    cliSettings: readCliSettings(account, env),
  };
  if (!credentials) return { ...base, seat: { state: "none" }, status: null };
  const seat = await probeSessionSeat(credentials.apiKey, AbortSignal.timeout(PROBE_TIMEOUT_MS));
  if (seat.unknown) return { ...base, seat: { state: "unknown" }, status: null };
  const active = seat.probe?.status === "active";
  return {
    ...base,
    seat: active
      ? { state: "active", ...(seat.probe?.model ? { model: seat.probe.model } : {}) }
      : { state: "none" },
    status: accountStatusFromProbe(seat.probe),
  };
}

/** Every account with seat, quota and read-only CLI settings. Never contains tokens. */
export async function listAccountDetails(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ accounts: AccountDetail[] }> {
  return describeAccountsIn(listAccounts(env), env);
}

/**
 * Every account in the stored display order (owner directive 2026-09-26:
 * "allow change order"), with the same per-account detail as listAccountDetails.
 */
export async function listAccountDetailsOrdered(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ accounts: AccountDetail[] }> {
  return describeAccountsIn(listAccountsOrdered(env), env);
}

/** Describe an account list in parallel (same shapes as listAccountDetails). */
async function describeAccountsIn(
  accounts: FreebuffAccount[],
  env: NodeJS.ProcessEnv,
): Promise<{ accounts: AccountDetail[] }> {
  return { accounts: await Promise.all(accounts.map((account) => describeAccount(account, env))) };
}

/**
 * Store the account display order. Ids must name known accounts without
 * repeats; unlisted accounts keep registration order after the listed ones.
 * Returns the full order that was stored.
 */
export function setAccountOrder(
  ids: string[],
  env: NodeJS.ProcessEnv = process.env,
): { order: string[] } {
  return { order: reorderAccounts(ids, env) };
}

/**
 * Email of a registered account from its stored login record (S5, owner
 * directive: approval prompts must name the account). Best-effort: null when
 * the account is unknown or has no stored email. Never returns tokens.
 */
export function accountUserEmail(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const account = findAccount(accountId, env);
  if (!account) return null;
  return readStoredIdentity(account, env).email ?? null;
}

export type EndSessionResult =
  | { result: "ended" }
  | { result: "no-session" }
  | { result: "unauthenticated" }
  | { result: "unknown" };

function requireAccount(id: string, env: NodeJS.ProcessEnv): FreebuffAccount {
  const account = listAccounts(env).find((candidate) => candidate.id === id);
  if (!account) throw new Error(`No such account "${id}".`);
  return account;
}

/**
 * End the account's live Freebuff seat (frees the slot; the next prompt opens
 * a new 5-Freebuck session). This can cut a run in progress on that seat.
 */
export async function endAccountSession(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EndSessionResult> {
  const account = requireAccount(id, env);
  const credentials = credentialsForAccount(account, env);
  if (!credentials) return { result: "unauthenticated" };
  const seat = await probeSessionSeat(credentials.apiKey, AbortSignal.timeout(PROBE_TIMEOUT_MS));
  if (seat.unknown) return { result: "unknown" };
  if (seat.probe?.status !== "active" || !seat.probe.instanceId) return { result: "no-session" };
  await releaseFreebuffSession({ token: credentials.apiKey, instanceId: seat.probe.instanceId });
  return { result: "ended" };
}

export interface RemoveResult {
  removed: boolean;
  deletedCredentials: boolean;
}

/**
 * Unregister an extra account. For an adapter-managed one (created by the
 * login flow) its own config dir — credentials included — is deleted too;
 * a `freebuff login` dir the user registered is left untouched.
 */
export function removeAccountAndState(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): RemoveResult {
  if (!isValidAccountId(id)) throw new Error(`Invalid account id "${id}".`);
  const account = requireAccount(id, env);
  const managed = isManaged(account, env);
  const removed = removeAccount(id, env);
  let deletedCredentials = false;
  if (removed && managed && account.configDir) {
    fs.rmSync(account.configDir, { recursive: true, force: true });
    deletedCredentials = true;
  }
  return { removed, deletedCredentials };
}

/**
 * Choose the account new sessions start on. `"default"` is always accepted;
 * anything else must name a registered account.
 */
export function setAccountDefault(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): { defaultAccountId: string } {
  return { defaultAccountId: setDefaultAccount(id, env) };
}

/**
 * Rename an account's display label (the id is fixed). Registered accounts
 * are rewritten in accounts.json; the built-in default's label lives in the
 * prefs file. An empty label clears the override.
 */
export function renameAccountLabel(
  id: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): { id: string; label: string } {
  const renamed = renameAccount(id, label, env);
  if (!renamed) throw new Error(`No such account "${id}".`);
  return { id: renamed.id, label: accountDisplayName(renamed, env) };
}
