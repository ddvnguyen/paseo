import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAccountLabel, resolveCredentials, type ResolvedCredentials } from "./auth.js";

/**
 * Multiple Freebuff accounts in one adapter process.
 *
 * The built-in "default" account is whatever the adapter env resolves to
 * (FREEBUFF_API_KEY, or the config dir's credentials.json). Extra accounts are
 * registered in a small JSON file — each is just a Freebuff config directory
 * that `FREEBUFF_CONFIG_DIR=<dir> freebuff login` populated:
 *
 *   ~/.config/freebuff-acp/accounts.json
 *   [{ "id": "work", "label": "Work", "configDir": "/home/me/.config/manicode-work" }]
 *
 * Override the file with FREEBUFF_ACP_ACCOUNTS_FILE. The file holds paths only,
 * never tokens.
 *
 * F5 — the file is rewritten atomically (temp file + rename in the same
 * directory, mode 0600), so a crash mid-write can never leave a torn file
 * behind. A file that exists but fails to parse is a `corrupt` state, never
 * "no extra accounts": readers still fall back to the default account (there
 * is nothing else to serve) but log loudly and expose the state via
 * `readAccountsSnapshot`, and add/remove refuse to touch the file so a
 * recoverable file is never overwritten with an empty list.
 */

export const DEFAULT_ACCOUNT_ID = "default";

export interface FreebuffAccount {
  id: string;
  /** Display label; falls back to the name stored in the account's credentials. */
  label?: string;
  /** Config dir holding credentials.json; null = the adapter's own environment. */
  configDir: string | null;
}

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Same id rules as addAccount: lowercase letters/digits/`-`/`_`, not "default". */
export function isValidAccountId(id: string): boolean {
  return ACCOUNT_ID_PATTERN.test(id) && id !== DEFAULT_ACCOUNT_ID;
}

/** API identity a derived account id comes from (the login status user record). */
export interface ApiIdentity {
  id: string;
  email: string;
}

/** One sanitization pass toward ACCOUNT_ID_PATTERN; null when nothing usable remains. */
function sanitizeAccountId(value: string): string | null {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 32);
  if (!cleaned || !isValidAccountId(cleaned)) return null;
  return cleaned;
}

/** The API user id stored in an account's credentials.json, if readable. */
function storedApiUserId(configDir: string | null): string | null {
  if (!configDir) return null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(configDir, "credentials.json"), "utf8"),
    ) as { default?: { id?: unknown } };
    return typeof parsed?.default?.id === "string" && parsed.default.id ? parsed.default.id : null;
  } catch {
    return null;
  }
}

/**
 * Account id derived from the API user record: the sanitized API user id,
 * else the sanitized email local-part, else "account". A re-login by the same
 * API user keeps its id and config dir (credentials refresh in place);
 * anything else registered under the base id gets a "-2", "-3", … suffix.
 */
export function deriveAccountId(
  identity: ApiIdentity,
  env: NodeJS.ProcessEnv = process.env,
): { id: string; reusedConfigDir: string | null } {
  const registered = readAccountsSnapshot(env).accounts;
  const base =
    sanitizeAccountId(identity.id) ??
    sanitizeAccountId(identity.email.split("@")[0] ?? "") ??
    "account";
  for (const account of registered) {
    if (account.id !== base) continue;
    if (storedApiUserId(account.configDir) === identity.id) {
      return { id: base, reusedConfigDir: account.configDir };
    }
  }
  let candidate = base;
  for (let n = 2; registered.some((account) => account.id === candidate); n += 1) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
  }
  return { id: candidate, reusedConfigDir: null };
}

/** Outcome of reading accounts.json. */
export type AccountsFileState = "missing" | "ok" | "corrupt";

export interface AccountsSnapshot {
  /**
   * `missing` = no file (the benign default-only fallback);
   * `ok` = parsed (individually invalid rows are still skipped);
   * `corrupt` = the file exists but could not be parsed as an account array.
   */
  state: AccountsFileState;
  /** Valid extra accounts; [] when missing or corrupt. */
  accounts: FreebuffAccount[];
}

/**
 * Where a named account keeps its own state (login handshake files, its own
 * credentials). Uses the same base as accounts.json so everything the adapter
 * writes lives under one root: XDG_CONFIG_HOME (or ~/.config) + freebuff-acp.
 * Override the whole base with FREEBUFF_ACP_CONFIG_DIR.
 */
export function accountsBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FREEBUFF_ACP_CONFIG_DIR?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "freebuff-acp");
}

/**
 * Per-account config dir (created on demand by the login flow, holding the
 * login-pending file and, after a successful login, that account's own
 * credentials.json). The id must already be validated.
 */
export function accountConfigDir(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  // Deployments that only relocated accounts.json keep per-account state next
  // to it instead of splitting the registry and its state across two roots.
  const relocatedFile = env.FREEBUFF_ACP_ACCOUNTS_FILE?.trim();
  const root =
    !env.FREEBUFF_ACP_CONFIG_DIR?.trim() && relocatedFile && path.isAbsolute(relocatedFile)
      ? path.dirname(relocatedFile)
      : accountsBaseDir(env);
  return path.join(root, "accounts", accountId);
}

export function accountsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FREEBUFF_ACP_ACCOUNTS_FILE?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(accountsBaseDir(env), "accounts.json");
}

function warn(message: string): void {
  process.stderr.write(`freebuff-acp: ${message}\n`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validate one raw JSON row; null when the entry is not a usable account. */
function parseAccountEntry(entry: unknown): FreebuffAccount | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { id, label, configDir } = entry as Record<string, unknown>;
  if (typeof id !== "string" || !ACCOUNT_ID_PATTERN.test(id) || id === DEFAULT_ACCOUNT_ID) {
    return null;
  }
  if (typeof configDir !== "string" || !path.isAbsolute(configDir)) return null;
  return {
    id,
    configDir,
    ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
  };
}

function parseExtraAccounts(parsed: unknown): FreebuffAccount[] {
  if (!Array.isArray(parsed)) return [];
  const accounts: FreebuffAccount[] = [];
  for (const entry of parsed) {
    const account = parseAccountEntry(entry);
    if (account) accounts.push(account);
  }
  return accounts;
}

/**
 * F5: read accounts.json distinguishing a missing file (benign) from one that
 * exists but cannot be parsed (corrupt — logged, never silently "empty").
 * Never throws; readers always get a snapshot.
 */
export function readAccountsSnapshot(env: NodeJS.ProcessEnv = process.env): AccountsSnapshot {
  const file = accountsFilePath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { state: "missing", accounts: [] };
    }
    warn(
      `accounts file ${file} is unreadable (${describeError(error)}); ` +
        "using the default account only.",
    );
    return { state: "corrupt", accounts: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    warn(
      `accounts file ${file} is corrupt (${describeError(error)}); keeping it untouched and ` +
        "using the default account only. Fix or remove the file, then re-register accounts.",
    );
    return { state: "corrupt", accounts: [] };
  }
  if (!Array.isArray(parsed)) {
    warn(
      `accounts file ${file} is corrupt (expected a JSON array of accounts); ` +
        "keeping it untouched and using the default account only.",
    );
    return { state: "corrupt", accounts: [] };
  }
  return { state: "ok", accounts: parseExtraAccounts(parsed) };
}

/**
 * Adapter-side preferences that are not accounts: which account new sessions
 * start on and the built-in default's display-label override. Stored in a
 * small file next to accounts.json so accounts.json keeps holding paths only:
 *
 *   ~/.config/freebuff-acp/accounts-prefs.json
 *   { "defaultAccountId": "work", "defaultLabel": "Personal" }
 *
 * A missing or corrupt file means "no preferences": readers fall back to the
 * built-in default and never throw.
 */
export interface AccountsPrefs {
  /** Account new sessions start on; "default" or a registered id. */
  defaultAccountId?: string;
  /** Display-label override for the built-in default account. */
  defaultLabel?: string;
  /**
   * Display order of accounts (owner directive 2026-09-26): ids in the order
   * the settings screen lists them. Ids not listed keep registration order
   * after the listed ones. Purely cosmetic — never affects which account is
   * the default or how credentials resolve.
   */
  accountOrder?: string[];
}

export function accountsPrefsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(accountsFilePath(env)), "accounts-prefs.json");
}

function parseAccountsPrefs(parsed: unknown): AccountsPrefs {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const prefs: AccountsPrefs = {};
  const { defaultAccountId, defaultLabel, accountOrder } = parsed as Record<string, unknown>;
  if (typeof defaultAccountId === "string" && defaultAccountId.trim()) {
    prefs.defaultAccountId = defaultAccountId.trim();
  }
  if (typeof defaultLabel === "string" && defaultLabel.trim()) {
    prefs.defaultLabel = defaultLabel.trim();
  }
  if (
    Array.isArray(accountOrder) &&
    accountOrder.every((id) => typeof id === "string" && id.trim())
  ) {
    prefs.accountOrder = accountOrder.map((id) => (id as string).trim());
  }
  return prefs;
}

/** Read accounts-prefs.json; missing/corrupt/unreadable = no preferences. */
export function readAccountsPrefs(env: NodeJS.ProcessEnv = process.env): AccountsPrefs {
  const file = accountsPrefsFilePath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    warn(
      `accounts prefs file ${file} is unreadable (${describeError(error)}); ` +
        "using the built-in default account.",
    );
    return {};
  }
  try {
    return parseAccountsPrefs(JSON.parse(raw));
  } catch (error) {
    warn(
      `accounts prefs file ${file} is corrupt (${describeError(error)}); ` +
        "using the built-in default account.",
    );
    return {};
  }
}

/** Same atomic temp-file + rename write as accounts.json, mode 0600. */
function writeAccountsPrefs(prefs: AccountsPrefs, env: NodeJS.ProcessEnv): void {
  const file = accountsPrefsFilePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Accounts in display order: the stored accountOrder first (in stored order,
 * unknown ids skipped), then any unlisted accounts in registration order.
 * Always the same set as listAccounts — only the sequence differs.
 */
export function listAccountsOrdered(env: NodeJS.ProcessEnv = process.env): FreebuffAccount[] {
  const accounts = listAccounts(env);
  const order = readAccountsPrefs(env).accountOrder;
  if (!order || order.length === 0) return accounts;
  const rank = new Map<string, number>();
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });
  return [...accounts].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * Persist the display order of accounts. Every id must name a known account
 * ("default" or registered) and none may repeat; unlisted accounts keep
 * registration order after the listed ones. Returns the resolved order that
 * was stored (not just the input).
 */
export function reorderAccounts(ids: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const known = new Set(listAccounts(env).map((account) => account.id));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!known.has(id)) throw new Error(`No such account "${raw}".`);
    if (seen.has(id)) throw new Error(`Duplicate account "${id}" in order.`);
    seen.add(id);
    ordered.push(id);
  }
  const rest = listAccounts(env)
    .map((account) => account.id)
    .filter((id) => !seen.has(id));
  const full = [...ordered, ...rest];
  const prefs = readAccountsPrefs(env);
  prefs.accountOrder = full;
  writeAccountsPrefs(prefs, env);
  return full;
}

/** The default account first, then any registered extras. */
export function listAccounts(env: NodeJS.ProcessEnv = process.env): FreebuffAccount[] {
  return [{ id: DEFAULT_ACCOUNT_ID, configDir: null }, ...readAccountsSnapshot(env).accounts];
}

/**
 * Account id new sessions start on: the stored default when it still names
 * "default" or a registered account (a removed account self-heals), else the
 * built-in "default". A missing/corrupt prefs file is the built-in default.
 */
export function resolveDefaultAccountId(env: NodeJS.ProcessEnv = process.env): string {
  const stored = readAccountsPrefs(env).defaultAccountId;
  if (
    stored &&
    (stored === DEFAULT_ACCOUNT_ID ||
      readAccountsSnapshot(env).accounts.some((account) => account.id === stored))
  ) {
    return stored;
  }
  return DEFAULT_ACCOUNT_ID;
}

/**
 * The named account, or — when no id is given — the stored default.
 * An unknown explicit id returns null (callers fall back to the default).
 */
export function findAccount(
  accountId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FreebuffAccount | null {
  const requested = accountId?.trim();
  const id = requested ? requested : resolveDefaultAccountId(env);
  return listAccounts(env).find((account) => account.id === id) ?? null;
}

/** Environment in which this account's credentials resolve. */
export function envForAccount(account: FreebuffAccount, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (account.configDir === null) return env;
  const scoped: NodeJS.ProcessEnv = { ...env, FREEBUFF_CONFIG_DIR: account.configDir };
  // A key in the environment would override the account's own credentials file.
  delete scoped.FREEBUFF_API_KEY;
  delete scoped.CODEBUFF_API_KEY;
  return scoped;
}

export function credentialsForAccount(
  account: FreebuffAccount,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCredentials | null {
  return resolveCredentials(envForAccount(account, env));
}

export function accountDisplayName(
  account: FreebuffAccount,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // The built-in default has no label of its own; its override lives in prefs.
  const override =
    account.id === DEFAULT_ACCOUNT_ID ? readAccountsPrefs(env).defaultLabel : account.label;
  return override ?? resolveAccountLabel(envForAccount(account, env));
}

/**
 * Choose the account new sessions start on: the built-in "default" or a
 * registered id. Throws when the id names no known account.
 * Returns the id that was stored.
 */
export function setDefaultAccount(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const accountId = id.trim();
  if (accountId !== DEFAULT_ACCOUNT_ID && !isValidAccountId(accountId)) {
    throw new Error(`Invalid account id "${id}".`);
  }
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    const registered = readAccountsSnapshot(env).accounts.some(
      (account) => account.id === accountId,
    );
    if (!registered) throw new Error(`No such account "${accountId}".`);
  }
  const prefs = readAccountsPrefs(env);
  prefs.defaultAccountId = accountId;
  writeAccountsPrefs(prefs, env);
  return accountId;
}

/**
 * Edit an account's display label only — the id is fixed. Registered accounts
 * are rewritten in accounts.json (addAccount-style atomic rewrite, refusing a
 * corrupt file); the built-in "default" keeps its override in
 * accounts-prefs.json. An empty label clears the override. Returns the
 * renamed account, or null when it vanished mid-write.
 */
export function renameAccount(
  id: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): FreebuffAccount | null {
  const accountId = id.trim();
  const trimmed = label.trim();
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const prefs = readAccountsPrefs(env);
    if (trimmed) prefs.defaultLabel = trimmed;
    else delete prefs.defaultLabel;
    writeAccountsPrefs(prefs, env);
    return findAccount(DEFAULT_ACCOUNT_ID, env);
  }
  if (!isValidAccountId(accountId)) throw new Error(`Invalid account id "${id}".`);
  const file = accountsFilePath(env);
  const snapshot = readAccountsSnapshot(env);
  assertAccountsFileReadable(snapshot, file);
  const current = snapshot.accounts.find((account) => account.id === accountId);
  if (!current) throw new Error(`No such account "${accountId}".`);
  const renamed: FreebuffAccount = {
    id: accountId,
    configDir: current.configDir,
    ...(trimmed ? { label: trimmed } : {}),
  };
  // Replace in place so the account keeps its position in the list.
  writeExtraAccounts(
    snapshot.accounts.map((account) => (account.id === accountId ? renamed : account)),
    env,
  );
  return findAccount(accountId, env);
}

/**
 * F5: write via a temp file in the same directory + renameSync. rename(2) is
 * atomic, so a crash mid-write leaves either the old file or the new one —
 * never a torn file that reads as "no extra accounts".
 */
function writeExtraAccounts(accounts: FreebuffAccount[], env: NodeJS.ProcessEnv): void {
  const file = accountsFilePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    // On success the temp path was consumed by the rename; this is a no-op.
    fs.rmSync(tmp, { force: true });
  }
}

/** F5: add/remove must never overwrite a file they could not read. */
function assertAccountsFileReadable(snapshot: AccountsSnapshot, file: string): void {
  if (snapshot.state !== "corrupt") return;
  throw new Error(
    `Refusing to update "${file}": the accounts file exists but could not be parsed ` +
      "(corrupt or unreadable). Fix or remove it by hand first — overwriting it could " +
      "destroy the registered accounts.",
  );
}

/** Register (or update) an extra account. Throws on an invalid id or path. */
export function addAccount(
  input: { id: string; label?: string; configDir: string },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isValidAccountId(input.id)) {
    throw new Error(
      `Invalid account id "${input.id}": use lowercase letters, digits, - or _ (not "${DEFAULT_ACCOUNT_ID}").`,
    );
  }
  if (!path.isAbsolute(input.configDir)) {
    throw new Error("configDir must be an absolute path.");
  }
  const file = accountsFilePath(env);
  const snapshot = readAccountsSnapshot(env);
  assertAccountsFileReadable(snapshot, file);
  const rest = snapshot.accounts.filter((account) => account.id !== input.id);
  writeExtraAccounts(
    [
      ...rest,
      {
        id: input.id,
        configDir: input.configDir,
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      },
    ],
    env,
  );
}

export function removeAccount(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = accountsFilePath(env);
  const snapshot = readAccountsSnapshot(env);
  assertAccountsFileReadable(snapshot, file);
  const rest = snapshot.accounts.filter((account) => account.id !== id);
  if (rest.length === snapshot.accounts.length) return false;
  writeExtraAccounts(rest, env);
  // Removing the chosen default resets it to the built-in "default" account.
  const prefs = readAccountsPrefs(env);
  if (prefs.defaultAccountId === id) {
    prefs.defaultAccountId = DEFAULT_ACCOUNT_ID;
    writeAccountsPrefs(prefs, env);
  }
  return true;
}
