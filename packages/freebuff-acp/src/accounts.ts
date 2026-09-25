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

export function accountsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FREEBUFF_ACP_ACCOUNTS_FILE?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "freebuff-acp", "accounts.json");
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

/** The default account first, then any registered extras. */
export function listAccounts(env: NodeJS.ProcessEnv = process.env): FreebuffAccount[] {
  return [{ id: DEFAULT_ACCOUNT_ID, configDir: null }, ...readAccountsSnapshot(env).accounts];
}

export function findAccount(
  accountId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FreebuffAccount | null {
  const id = accountId || DEFAULT_ACCOUNT_ID;
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
  return account.label ?? resolveAccountLabel(envForAccount(account, env));
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
  if (!ACCOUNT_ID_PATTERN.test(input.id) || input.id === DEFAULT_ACCOUNT_ID) {
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
  return true;
}
