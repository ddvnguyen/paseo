import fs from "node:fs";
import path from "node:path";

import { accountConfigDir, addAccount, isValidAccountId } from "./accounts.js";
import { generateFingerprintId } from "./auth.js";
import { appUrl } from "./freebuff-session.js";

/**
 * Device-code login for a named account (mirrors the Freebuff CLI's
 * `login-flow.ts` + `plain-login.ts`, minus the TUI and analytics):
 *
 *   1. POST /api/auth/cli/code       — get loginUrl/fingerprintHash/expiresAt
 *   2. GET  /api/auth/cli/status?... — poll until the user approves in the browser
 *   3. credentials.json in the Freebuff CLI format + account registration
 *
 * Unlike the CLI, the adapter must survive restarts between 1 and 2, so the
 * handshake state (`fingerprintId`, `fingerprintHash`, server `expiresAt`)
 * persists in `<accountConfigDir>/.login-pending.json` (mode 0600 — it links
 * this device to a login that is not ours until it is approved).
 *
 * JSON output only. Token values are written to the account's credentials file
 * and are NEVER part of any output.
 */

/** Owner read/write: pending state links to a not-yet-approved login. */
const SECRET_FILE_MODE = 0o600;
/** Owner-only per-account config dir, matching the CLI's CONFIG_DIR_MODE. */
const ACCOUNT_DIR_MODE = 0o700;

const LOGIN_CODE_PATH = "/api/auth/cli/code";
const LOGIN_STATUS_PATH = "/api/auth/cli/status";

const PENDING_FILE = ".login-pending.json";
const FINGERPRINT_FILE = "fingerprint-id";

/** Server response for POST /api/auth/cli/code (`LoginCodeResponse` upstream). */
interface LoginCodeResponse {
  loginUrl: string;
  fingerprintHash: string;
  /**
   * A server-clock instant. The live server sends epoch milliseconds (a
   * number); older shapes sent a string. It is the status endpoint's HMAC
   * input, so it is echoed back as its exact decimal/string form.
   */
  expiresAt: string | number;
  /** Validity duration; the only clock-independent expiry signal. */
  expiresInMs?: number;
}

/** Server response for GET /api/auth/cli/status (`LoginStatusResponse` upstream). */
interface LoginStatusResponse {
  user?: Record<string, unknown>;
}

/**
 * What a login poll means. `pending` covers every non-answer: 401 (the code
 * is not redeemed *yet* — the status endpoint refuses to say more), network
 * errors and other non-OK statuses. `none` = no login is in progress for the
 * account (start one first).
 */
export type LoginPollStatus = "pending" | "expired" | "success" | "none";

export interface LoginStartResult {
  loginUrl: string;
  expiresAt: string;
}

export interface LoginPollResult {
  status: LoginPollStatus;
  /** Present only on success; the token is never included. */
  name?: string;
  email?: string;
}

interface PendingState {
  fingerprintId: string;
  fingerprintHash: string;
  /** Server instant, echoed byte-for-byte (it is the status endpoint's HMAC input). */
  expiresAt: string;
  /**
   * Local-clock deadline (epoch ms) = start time + the server's `expiresInMs`.
   * Preferred for the expired check: comparing the server's `expiresAt` with
   * this machine's clock rejects every code on a skewed clock.
   */
  localDeadlineMs?: number;
  /** Optional display label captured at start, reused when registering the account. */
  label?: string;
}

/**
 * The pending handshake for the account dir, or null when no login is in
 * progress (no file, unreadable, or unusable shape). Missing = "none",
 * never an error.
 */
function readPendingState(configDir: string): PendingState | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(configDir, PENDING_FILE), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const fingerprintId = record.fingerprintId;
  const fingerprintHash = record.fingerprintHash;
  const expiresAt = record.expiresAt;
  if (typeof fingerprintId !== "string" || !fingerprintId) return null;
  if (typeof fingerprintHash !== "string" || !fingerprintHash) return null;
  if (typeof expiresAt !== "string" || !expiresAt) return null;
  const label =
    typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined;
  const localDeadlineMs =
    typeof record.localDeadlineMs === "number" ? record.localDeadlineMs : undefined;
  return {
    fingerprintId,
    fingerprintHash,
    expiresAt,
    ...(localDeadlineMs === undefined ? {} : { localDeadlineMs }),
    ...(label ? { label } : {}),
  };
}

/**
 * Expired once the handshake's deadline has passed. Uses the local-clock
 * deadline derived from `expiresInMs`; falls back to the server instant
 * (epoch-ms number or ISO string) for pending files written without one.
 */
function isExpired(pending: PendingState, now: number): boolean {
  if (pending.localDeadlineMs !== undefined) return now > pending.localDeadlineMs;
  const numeric = Number(pending.expiresAt);
  const instant = Number.isNaN(numeric) ? Date.parse(pending.expiresAt) : numeric;
  if (Number.isNaN(instant)) return true;
  return now > instant;
}

/** Normalize the server's `expiresAt` (number or string) to its exact string form; null if absent. */
function expiresAtString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value) return value;
  return null;
}

/** `writeFileSync` applies `mode` only on create — re-tighten after every write. */
function tightenMode(filePath: string): void {
  try {
    if (fs.statSync(filePath).mode & 0o777) fs.chmodSync(filePath, SECRET_FILE_MODE);
  } catch {
    // Best-effort: a vanished file needs no chmod.
  }
}

/**
 * Step 1 — start (or restart) a device-code login for the account.
 *
 * Validates the id, creates the account config dir, persists a fresh random
 * per-account fingerprintId in it, POSTs the login-code request and records
 * the handshake in `.login-pending.json` (mode 0600). Calling again for the
 * same id restarts with a fresh link. The server's `expiresAt` instant is
 * echoed byte-for-byte (the status endpoint verifies it as its HMAC input).
 */
export async function startLogin(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
  label?: string,
): Promise<LoginStartResult> {
  assertValidId(id);
  const configDir = accountConfigDir(id, env);
  fs.mkdirSync(configDir, { recursive: true, mode: ACCOUNT_DIR_MODE });

  // A fresh random fingerprintId per attempt; the persisted copy keeps
  // `login-poll` (and any later re-run) on the same device identity.
  const fingerprintId = generateFingerprintId();
  const fingerprintFile = path.join(configDir, FINGERPRINT_FILE);
  fs.writeFileSync(fingerprintFile, `${fingerprintId}\n`, { mode: SECRET_FILE_MODE });
  tightenMode(fingerprintFile);

  const res = await fetchFn(`${appUrl()}${LOGIN_CODE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprintId }),
  });
  if (!res.ok) {
    throw new Error(`Login-code request failed with HTTP ${res.status}.`);
  }
  const body = (await res.json().catch(() => null)) as LoginCodeResponse | null;
  if (!body || typeof body.loginUrl !== "string" || !body.loginUrl) {
    throw new Error("Login-code request returned no login URL.");
  }
  const expiresAt = expiresAtString(body.expiresAt);
  if (!expiresAt) {
    throw new Error("Login-code request returned no expiry.");
  }
  if (typeof body.fingerprintHash !== "string" || !body.fingerprintHash) {
    throw new Error("Login-code request returned no fingerprint hash.");
  }

  const pending: PendingState = {
    fingerprintId,
    fingerprintHash: body.fingerprintHash,
    expiresAt,
    ...(typeof body.expiresInMs === "number" && body.expiresInMs > 0
      ? { localDeadlineMs: Date.now() + body.expiresInMs }
      : {}),
  };
  const trimmedLabel = label?.trim();
  if (trimmedLabel) pending.label = trimmedLabel;

  const pendingFile = path.join(configDir, PENDING_FILE);
  fs.writeFileSync(pendingFile, `${JSON.stringify(pending, null, 2)}\n`, {
    mode: SECRET_FILE_MODE,
  });
  tightenMode(pendingFile);

  return { loginUrl: body.loginUrl, expiresAt };
}

/**
 * Step 2 — poll for the browser approval. Reads the pending handshake file,
 * echoes `fingerprintHash`/`expiresAt` back to the status endpoint, and on
 * success writes the account's own credentials.json (Freebuff CLI format,
 * mode 0600), registers the account in accounts.json, and removes the
 * pending file. Without a pending file there is no login in progress.
 */
export async function pollLogin(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<LoginPollResult> {
  assertValidId(id);
  const configDir = accountConfigDir(id, env);
  const pending = readPendingState(configDir);
  if (!pending) return { status: "none" };

  if (isExpired(pending, Date.now())) {
    return { status: "expired" };
  }

  const params = new URLSearchParams({
    fingerprintId: pending.fingerprintId,
    fingerprintHash: pending.fingerprintHash,
    expiresAt: pending.expiresAt,
  });
  let res: Response;
  try {
    res = await fetchFn(`${appUrl()}${LOGIN_STATUS_PATH}?${params.toString()}`, { method: "GET" });
  } catch {
    // Transport failure: the code may still be redeemed — keep waiting.
    return { status: "pending" };
  }
  // 401 = not redeemed yet (the endpoint answers 401 until the browser
  // approves); any other non-OK status is equally non-answerable. Stay pending.
  if (!res.ok) return { status: "pending" };

  const body = (await res.json().catch(() => null)) as LoginStatusResponse | null;
  const user = body?.user;
  if (typeof user !== "object" || user === null) return { status: "pending" };

  writeAccountCredentials(configDir, user, pending.fingerprintId);
  addAccount({ id, configDir, ...(pending.label ? { label: pending.label } : {}) }, env);
  fs.rmSync(path.join(configDir, PENDING_FILE), { force: true });

  return { status: "success", name: displayNameOf(user), email: emailOf(user) };
}

/**
 * Step 3 — abandon an in-progress login: delete the pending file. The
 * server-side code simply expires on its own.
 */
export function cancelLogin(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): { status: "cancelled" } {
  assertValidId(id);
  fs.rmSync(path.join(accountConfigDir(id, env), PENDING_FILE), { force: true });
  return { status: "cancelled" };
}

function assertValidId(id: string): void {
  if (!isValidAccountId(id)) {
    throw new Error(
      `Invalid account id "${id}": use lowercase letters, digits, - or _ (not "default").`,
    );
  }
}

function writeAccountCredentials(
  configDir: string,
  user: Record<string, unknown>,
  fingerprintId: string,
): void {
  // Freebuff CLI credentials format (`saveUserCredentials` upstream): the
  // user under the "default" profile, `name` normalised to '' when absent.
  const storedUser: Record<string, unknown> = {
    ...user,
    fingerprintId,
    name: typeof user.name === "string" ? user.name : "",
  };
  const credentialsFile = path.join(configDir, "credentials.json");
  fs.writeFileSync(credentialsFile, `${JSON.stringify({ default: storedUser }, null, 2)}\n`, {
    mode: SECRET_FILE_MODE,
  });
  tightenMode(credentialsFile);
}

function displayNameOf(user: Record<string, unknown>): string {
  if (typeof user.name === "string" && user.name.trim()) return user.name;
  if (typeof user.email === "string") return user.email;
  return "";
}

function emailOf(user: Record<string, unknown>): string {
  return typeof user.email === "string" ? user.email : "";
}
