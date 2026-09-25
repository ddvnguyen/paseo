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

export function accountsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FREEBUFF_ACP_ACCOUNTS_FILE?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "freebuff-acp", "accounts.json");
}

function readExtraAccounts(env: NodeJS.ProcessEnv): FreebuffAccount[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(accountsFilePath(env), "utf8"));
    if (!Array.isArray(parsed)) return [];
    const accounts: FreebuffAccount[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const { id, label, configDir } = entry as Record<string, unknown>;
      if (typeof id !== "string" || !ACCOUNT_ID_PATTERN.test(id) || id === DEFAULT_ACCOUNT_ID) {
        continue;
      }
      if (typeof configDir !== "string" || !path.isAbsolute(configDir)) continue;
      accounts.push({
        id,
        configDir,
        ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
      });
    }
    return accounts;
  } catch {
    // Missing or unreadable file: only the default account.
    return [];
  }
}

/** The default account first, then any registered extras. */
export function listAccounts(env: NodeJS.ProcessEnv = process.env): FreebuffAccount[] {
  return [{ id: DEFAULT_ACCOUNT_ID, configDir: null }, ...readExtraAccounts(env)];
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

function writeExtraAccounts(accounts: FreebuffAccount[], env: NodeJS.ProcessEnv): void {
  const file = accountsFilePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
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
  const rest = readExtraAccounts(env).filter((account) => account.id !== input.id);
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
  const current = readExtraAccounts(env);
  const rest = current.filter((account) => account.id !== id);
  if (rest.length === current.length) return false;
  writeExtraAccounts(rest, env);
  return true;
}
