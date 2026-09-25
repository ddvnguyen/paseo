import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  accountConfigDir,
  addAccount,
  isValidAccountId,
  readAccountsSnapshot,
} from "./accounts.js";
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

/** Bound on each login HTTP call so a hung backend cannot hang the CLI. */
const HTTP_TIMEOUT_MS = 15_000;

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
export type LoginPollStatus = "pending" | "expired" | "success" | "none" | "error";

export interface LoginStartResult {
  loginUrl: string;
  expiresAt: string;
}

export interface LoginPollResult {
  status: LoginPollStatus;
  /** Set on `pending` when the server answered with something other than 401. */
  httpStatus?: number;
  /** Set on `error`: why the poll could not be answered (never contains secrets). */
  reason?: string;
  /** Present only on success; the token is never included. */
  name?: string;
  email?: string;
}

interface PendingState {
  /**
   * Random per-start value. A poll re-reads the file after its network call and
   * only completes when the nonce is unchanged, so a cancel or restart that ran
   * meanwhile is honored instead of being overwritten by the stale poll.
   */
  nonce: string;
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

type PendingRead =
  | { kind: "none" }
  | { kind: "unreadable"; reason: string }
  | { kind: "pending"; state: PendingState };

/**
 * The pending handshake for the account dir. Only a missing file means "no
 * login in progress"; an unreadable or malformed file is reported as such so a
 * live login is never mistaken for none.
 */
function readPendingState(configDir: string): PendingRead {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(configDir, PENDING_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "unreadable", reason: "pending login file is not readable" };
  }
  const state = parsePendingState(raw);
  return state
    ? { kind: "pending", state }
    : { kind: "unreadable", reason: "pending login file is malformed" };
}

function parsePendingState(raw: string): PendingState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const { nonce, fingerprintId, fingerprintHash, expiresAt } = record;
  if (typeof nonce !== "string" || !nonce) return null;
  if (typeof fingerprintId !== "string" || !fingerprintId) return null;
  if (typeof fingerprintHash !== "string" || !fingerprintHash) return null;
  if (typeof expiresAt !== "string" || !expiresAt) return null;
  const label =
    typeof record.label === "string" && record.label.trim() ? record.label.trim() : undefined;
  const localDeadlineMs =
    typeof record.localDeadlineMs === "number" ? record.localDeadlineMs : undefined;
  return {
    nonce,
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
  const instant = instantOf(pending.expiresAt);
  if (Number.isNaN(instant)) return true;
  return now > instant;
}

/** Epoch ms of a server instant given as a decimal string or an ISO string; NaN if neither. */
function instantOf(expiresAt: string): number {
  const numeric = Number(expiresAt);
  return Number.isNaN(numeric) ? Date.parse(expiresAt) : numeric;
}

/** Normalize the server's `expiresAt` (number or string) to its exact string form; null if absent. */
function expiresAtString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value) return value;
  return null;
}

/**
 * Write a secret file atomically: temp file in the same directory (mode 0600)
 * then rename, so a crash or a concurrent reader never sees a torn file.
 */
function writeSecretFileAtomic(filePath: string, content: string): void {
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode: SECRET_FILE_MODE });
    fs.chmodSync(temp, SECRET_FILE_MODE);
    fs.renameSync(temp, filePath);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Create the per-account dir and tighten it (and only it) to owner-only. */
function ensureAccountDir(configDir: string): void {
  fs.mkdirSync(configDir, { recursive: true, mode: ACCOUNT_DIR_MODE });
  fs.chmodSync(configDir, ACCOUNT_DIR_MODE);
}

/**
 * Refuse to re-login an id that is registered against a different config dir
 * (e.g. one populated by `freebuff login`): success would silently rebind it.
 */
function assertNotRegisteredElsewhere(id: string, configDir: string, env: NodeJS.ProcessEnv): void {
  const existing = readAccountsSnapshot(env).accounts.find((account) => account.id === id);
  if (existing && existing.configDir !== configDir) {
    throw new Error(
      `Account "${id}" is already registered with a different config dir; remove it first (accounts remove ${id}) or pick another id.`,
    );
  }
}

/** Reuse the account's stored device fingerprint so restarts keep one identity. */
function loadOrCreateFingerprint(configDir: string): { id: string; isNew: boolean } {
  const file = path.join(configDir, FINGERPRINT_FILE);
  try {
    const stored = fs.readFileSync(file, "utf8").trim();
    if (stored) return { id: stored, isNew: false };
  } catch {
    // Missing/unreadable: mint a new one below.
  }
  return { id: generateFingerprintId(), isNew: true };
}

/** POST the login-code request; validated body or a descriptive error. */
async function requestLoginCode(fingerprintId: string, fetchFn: typeof fetch) {
  const res = await fetchFn(`${appUrl()}${LOGIN_CODE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprintId }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Login-code request failed with HTTP ${res.status}.`);
  const body = (await res.json().catch(() => null)) as LoginCodeResponse | null;
  if (!body || typeof body.loginUrl !== "string" || !body.loginUrl) {
    throw new Error("Login-code request returned no login URL.");
  }
  if (typeof body.fingerprintHash !== "string" || !body.fingerprintHash) {
    throw new Error("Login-code request returned no fingerprint hash.");
  }
  const expiresAt = expiresAtString(body.expiresAt);
  const hasDuration = typeof body.expiresInMs === "number" && body.expiresInMs > 0;
  // Without a duration the only expiry signal is the server instant compared
  // with the local clock, which the upstream contract warns against; require
  // a parseable instant in that case rather than guessing.
  if (!expiresAt || (!hasDuration && Number.isNaN(instantOf(expiresAt)))) {
    throw new Error("Login-code request returned no usable expiry.");
  }
  return { body, expiresAt };
}

/**
 * Step 1 — start (or restart) a device-code login for the account.
 *
 * Validates the id, creates the account config dir, keeps one stable
 * per-account fingerprintId (persisted only after the server accepted it),
 * POSTs the login-code request and records the handshake in
 * `.login-pending.json` (0600, atomic). Calling again for the same id
 * restarts with a fresh link and invalidates any in-flight poll. The server's
 * `expiresAt` is echoed byte-for-byte (it is the status endpoint's HMAC input).
 */
export async function startLogin(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
  label?: string,
): Promise<LoginStartResult> {
  assertValidId(id);
  const configDir = accountConfigDir(id, env);
  assertNotRegisteredElsewhere(id, configDir, env);
  ensureAccountDir(configDir);

  const fingerprint = loadOrCreateFingerprint(configDir);
  const { body, expiresAt } = await requestLoginCode(fingerprint.id, fetchFn);
  if (fingerprint.isNew) {
    writeSecretFileAtomic(path.join(configDir, FINGERPRINT_FILE), `${fingerprint.id}\n`);
  }

  const pending: PendingState = {
    nonce: crypto.randomBytes(16).toString("hex"),
    fingerprintId: fingerprint.id,
    fingerprintHash: body.fingerprintHash,
    expiresAt,
    ...(typeof body.expiresInMs === "number" && body.expiresInMs > 0
      ? { localDeadlineMs: Date.now() + body.expiresInMs }
      : {}),
    ...(label?.trim() ? { label: label.trim() } : {}),
  };
  writeSecretFileAtomic(
    path.join(configDir, PENDING_FILE),
    `${JSON.stringify(pending, null, 2)}\n`,
  );
  return { loginUrl: body.loginUrl, expiresAt };
}

interface RedeemedUser {
  record: Record<string, unknown>;
  name: string;
  email: string;
}

/** The status response's user, only when it is usable by the CLI and adapter. */
function usableUser(value: unknown): RedeemedUser | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { id, email, authToken } = record;
  if (typeof id !== "string" || !id) return null;
  if (typeof email !== "string" || !email) return null;
  if (typeof authToken !== "string" || !authToken) return null;
  const name = typeof record.name === "string" ? record.name : "";
  return { record, name, email };
}

/** GET the status endpoint; a `pending`/`error` result, or the redeemed user. */
async function fetchLoginStatus(
  state: PendingState,
  fetchFn: typeof fetch,
): Promise<LoginPollResult | RedeemedUser> {
  const params = new URLSearchParams({
    fingerprintId: state.fingerprintId,
    fingerprintHash: state.fingerprintHash,
    expiresAt: state.expiresAt,
  });
  let res: Response;
  try {
    res = await fetchFn(`${appUrl()}${LOGIN_STATUS_PATH}?${params.toString()}`, {
      method: "GET",
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    // Transport failure or timeout: the code may still be redeemed — keep waiting.
    return { status: "pending" };
  }
  // 401 = not redeemed yet; other non-OK statuses are surfaced so callers can
  // back off or alert instead of polling a failing backend silently.
  if (res.status === 401) return { status: "pending" };
  if (!res.ok) return { status: "pending", httpStatus: res.status };
  const body = (await res.json().catch(() => null)) as LoginStatusResponse | null;
  if (body?.user === undefined || body.user === null) return { status: "pending" };
  const user = usableUser(body.user);
  return user ?? { status: "error", reason: "login response had no usable user record" };
}

/** True while the on-disk handshake is still the one this poll started with. */
function stillCurrent(configDir: string, nonce: string): boolean {
  const current = readPendingState(configDir);
  return current.kind === "pending" && current.state.nonce === nonce;
}

/**
 * Step 2 — poll for the browser approval. Echoes the handshake to the status
 * endpoint; on success writes the account's credentials.json (Freebuff CLI
 * format, 0600, atomic), registers the account and removes the pending file.
 * A cancel or restart that happened during the network call wins.
 */
export async function pollLogin(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<LoginPollResult> {
  assertValidId(id);
  const configDir = accountConfigDir(id, env);
  const read = readPendingState(configDir);
  if (read.kind === "none") return { status: "none" };
  if (read.kind === "unreadable") return { status: "error", reason: read.reason };
  const pending = read.state;
  if (isExpired(pending, Date.now())) return { status: "expired" };

  const outcome = await fetchLoginStatus(pending, fetchFn);
  if (!("record" in outcome)) return outcome;
  if (!stillCurrent(configDir, pending.nonce)) return { status: "none" };
  return completeLogin({ id, configDir, pending, user: outcome, env });
}

/** Persist a redeemed login: credentials, registration, then clear the handshake. */
function completeLogin(input: {
  id: string;
  configDir: string;
  pending: PendingState;
  user: RedeemedUser;
  env: NodeJS.ProcessEnv;
}): LoginPollResult {
  const { id, configDir, pending, user, env } = input;
  writeAccountCredentials(configDir, user, pending.fingerprintId);
  // The code is redeemed server-side and cannot be polled again, so the
  // handshake is dropped whether or not registration below succeeds.
  fs.rmSync(path.join(configDir, PENDING_FILE), { force: true });
  try {
    addAccount({ id, configDir, ...(pending.label ? { label: pending.label } : {}) }, env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Logged in, but registering "${id}" failed (${reason}). Credentials were saved in ${configDir}; register with: accounts add ${id} ${configDir}`,
      { cause: error },
    );
  }
  return { status: "success", name: user.name || user.email, email: user.email };
}

/**
 * Step 3 — abandon an in-progress login: delete the pending file (a running
 * poll then reports `none`). The server-side code is not revoked: it stays
 * redeemable until it expires, so do not share the link.
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
  user: RedeemedUser,
  fingerprintId: string,
): void {
  // Freebuff CLI credentials format (`saveUserCredentials` upstream): the
  // user under the "default" profile, `name` normalised to '' when absent.
  const storedUser: Record<string, unknown> = {
    ...user.record,
    fingerprintId,
    name: user.name,
  };
  writeSecretFileAtomic(
    path.join(configDir, "credentials.json"),
    `${JSON.stringify({ default: storedUser }, null, 2)}\n`,
  );
}
