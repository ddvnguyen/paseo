import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where the Freebuff CLI (and Codebuff CLI) store login credentials.
 *
 * Both CLIs resolve their config dir to `~/.config/manicode` on production
 * (`FREEBUFF_CONFIG_DIR` overrides it). The credentials file contains the
 * logged-in user under the `default` key.
 */
export function getCredentialsPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.FREEBUFF_CONFIG_DIR?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? path.join(configured, "credentials.json") : null;
  }
  return path.join(os.homedir(), ".config", "manicode", "credentials.json");
}

interface StoredCredentials {
  default?: {
    id?: unknown;
    name?: unknown;
    email?: unknown;
    authToken?: unknown;
    fingerprintId?: unknown;
  };
}

export interface ResolvedCredentials {
  apiKey: string;
  fingerprintId?: string;
  source: "env" | "credentials-file";
}

/**
 * Resolve backend credentials with the same precedence the Freebuff CLI uses:
 *
 * 1. `FREEBUFF_API_KEY` / `CODEBUFF_API_KEY` env vars (explicit override)
 * 2. The logged-in CLI's `credentials.json` (what `freebuff login` writes)
 *
 * `readCredentialsFile` is injectable for tests.
 */
export function resolveCredentials(
  env: NodeJS.ProcessEnv = process.env,
  readCredentialsFile: (p: string) => StoredCredentials | null = readStoredCredentials,
): ResolvedCredentials | null {
  const envKey = env.FREEBUFF_API_KEY?.trim() || env.CODEBUFF_API_KEY?.trim() || "";
  if (envKey) {
    return { apiKey: envKey, source: "env" };
  }

  const credentialsPath = getCredentialsPath(env);
  if (!credentialsPath) return null;

  const stored = readCredentialsFile(credentialsPath);
  const authToken = stored?.default?.authToken;
  if (typeof authToken === "string" && authToken.length > 0) {
    const fingerprintId =
      typeof stored?.default?.fingerprintId === "string" && stored.default.fingerprintId.length > 0
        ? stored.default.fingerprintId
        : undefined;
    return { apiKey: authToken, fingerprintId, source: "credentials-file" };
  }
  return null;
}

function readStoredCredentials(credentialsPath: string): StoredCredentials | null {
  try {
    if (!fs.existsSync(credentialsPath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as StoredCredentials;
  } catch {
    return null;
  }
}

/** Sync fingerprint id generation mirroring the Codebuff SDK default (hex sha256). */
export function generateFingerprintId(): string {
  return crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
}

/**
 * Who the adapter is logged in as, for display only (never the token).
 * Prefers the stored display name, then the email; env-key auth has no
 * identity on disk.
 */
export function resolveAccountLabel(
  env: NodeJS.ProcessEnv = process.env,
  readCredentialsFile: (p: string) => StoredCredentials | null = readStoredCredentials,
): string {
  const envKey = env.FREEBUFF_API_KEY?.trim() || env.CODEBUFF_API_KEY?.trim() || "";
  if (envKey) return "API key (env)";
  const credentialsPath = getCredentialsPath(env);
  const stored = credentialsPath ? readCredentialsFile(credentialsPath) : null;
  for (const candidate of [stored?.default?.name, stored?.default?.email]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "Freebuff account";
}
