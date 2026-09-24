/**
 * Freebuff free-session admission protocol.
 *
 * The Freebuff CLI never talks to the backend in free mode without first
 * holding a session slot. The protocol (mirrors
 * `cli/src/utils/freebuff-session-api.ts` + `use-freebuff-session.ts`):
 *
 *   1. GET  /api/v1/freebuff/session           — probe; if `active` with an
 *      instanceId, the slot is already ours (e.g. held by a concurrent CLI or
 *      a prior turn) and MUST be reused rather than POSTed over.
 *   2. POST /api/v1/freebuff/session/admission — claim a slot; returns
 *      `active` + instanceId, or a typed waiting-room state.
 *   3. DELETE /api/v1/freebuff/session         — release the slot when done.
 *
 * The instanceId then rides every run as
 * `extraCodebuffMetadata.freebuff_instance_id`; without it the backend
 * answers runs with `waiting_room_required`.
 *
 * NOTE ON HOSTING: `codebuff.com` 301s to `www.codebuff.com`, and the
 * redirect strips the Authorization header — so calls to the apex host fail
 * with 401 regardless of token validity. The CLI's `NEXT_PUBLIC_CODEBUFF_APP_URL`
 * already points at www; we default to www too.
 */
import type { FreebuffSessionServerResponse } from "./types.js";

/** Upstream constants (`@codebuff/common/constants/freebuff-models`). */
const INSTANCE_HEADER = "x-freebuff-instance-id";
const MODEL_HEADER = "x-freebuff-model";
const FIRST_TAB_DISCOUNT_HEADER = "x-freebuff-first-tab-discount";
const WALLET_SPEND_LIMIT_HEADER = "x-freebuff-wallet-spend-limit";
/** Upstream constant (`@codebuff/common/util/freebucks-timezone`). */
const TIMEZONE_HEADER = "x-fb-timezone";

const ADMISSION_PATH = "/api/v1/freebuff/session/admission";
const SESSION_PATH = "/api/v1/freebuff/session";

function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL ||
    process.env.CODEBUFF_APP_URL ||
    "https://www.codebuff.com"
  ).replace(/\/$/, "");
}

export type AdmissionResult =
  | { ok: true; instanceId: string; model: string; accessTier?: string; reused: boolean }
  | { ok: false; waitingRoom: true; message?: string }
  | { ok: false; terminal: true; message: string };

/** What the host approves before a credit-spending session open. */
export interface SessionOpenInfo {
  model: string;
  /** Catalog price of one hour on `model`, when the probe reported it. */
  priceFreebucks?: number;
  /** Freebucks left in the daily pool, when the probe reported it. */
  dailyRemaining?: number;
}

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    [TIMEZONE_HEADER]: safeTimezone(),
  };
}

/** Probe for a live slot this account already holds (GET; non-fatal). */
async function probeOpenSession(
  token: string,
  signal?: AbortSignal,
): Promise<FreebuffSessionServerResponse | null> {
  try {
    const res = await fetch(`${appUrl()}${SESSION_PATH}`, {
      method: "GET",
      headers: baseHeaders(token),
      signal,
    });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as FreebuffSessionServerResponse | null;
  } catch {
    // Probe failures are non-fatal; fall through to POST.
    return null;
  }
}

/** Interpret an admission POST response into the typed AdmissionResult. */
async function interpretAdmissionResponse(res: Response, model: string): Promise<AdmissionResult> {
  let body: (FreebuffSessionServerResponse & { error?: string }) | null = null;
  try {
    body = (await res.json()) as FreebuffSessionServerResponse & { error?: string };
  } catch {
    body = null;
  }

  if (res.ok && body?.status === "active" && body.instanceId) {
    return {
      ok: true,
      instanceId: body.instanceId,
      model: body.model ?? model,
      accessTier: body.accessTier,
      reused: false,
    };
  }

  if (body && typeof body.status === "string") {
    const message = body.message ?? (body.error ? `${body.error}` : undefined);
    switch (body.status) {
      case "country_blocked":
      case "banned":
        return {
          ok: false,
          terminal: true,
          message: message ?? `Freebuff refused admission: ${body.status}`,
        };
      default:
        // model_locked, rate_limited, spend_limited, ip_capped,
        // premium_slot_taken, superseded, ended, none, ... are all
        // waiting-room-like: the caller may succeed on a later attempt.
        return { ok: false, waitingRoom: true, message };
    }
  }

  return {
    ok: false,
    waitingRoom: true,
    message: body?.message ?? body?.error ?? `Admission failed with HTTP ${res.status}`,
  };
}

/**
 * Hold a free-session slot for `model`.
 *
 * Protocol order matters: GET first so a slot already held by this account
 * (another adapter instance, or the CLI) is reused instead of superseded.
 * POST is only sent when nothing live is held. `model_locked` from a
 * deliberate pick means a live session on another model exists — reported as
 * a waiting-room-style retryable state with its message.
 */
export async function admitFreebuffSession(opts: {
  token: string;
  model?: string;
  signal?: AbortSignal;
  /** Host consent hook; asked only when no live slot exists (POST = credit spend). */
  confirmOpen?: (info: SessionOpenInfo) => Promise<boolean>;
}): Promise<AdmissionResult> {
  const model = opts.model?.trim() || DEFAULT_MODEL_FALLBACK;

  // 1. Probe: reuse a live slot when one exists.
  const probe = await probeOpenSession(opts.token, opts.signal);
  if (probe?.status === "active" && probe.instanceId) {
    // An already-open free session is never a hard block. Prefer the slot's
    // model (runs must match `x-freebuff-model`); if the probe omitted it,
    // keep the requested model. Returning ok lets the turn adopt the open
    // instance instead of parking the prompt in the waiting room.
    return {
      ok: true,
      instanceId: probe.instanceId,
      model: probe.model?.trim() || model,
      accessTier: probe.accessTier,
      reused: true,
    };
  }

  // 2. Nothing live: the POST below opens a NEW 1-hour slot that costs
  // credit. Ask the host first — decline (or an unanswerable request) means
  // no spend. Reused slots above never reach this gate.
  if (opts.confirmOpen) {
    const freebucks = probe?.freebucks;
    let openConfirmed = false;
    try {
      openConfirmed = await opts.confirmOpen({
        model,
        priceFreebucks: freebucks?.prices?.[model],
        dailyRemaining: freebucks?.daily?.remaining,
      });
    } catch {
      // Fail closed: never spend credit when consent cannot be obtained.
      openConfirmed = false;
    }
    if (!openConfirmed) {
      return {
        ok: false,
        terminal: true,
        message: "New free-session open was declined in the host — no credit spent.",
      };
    }
  }

  // 3. Admission POST.
  const headers: Record<string, string> = {
    ...baseHeaders(opts.token),
    [MODEL_HEADER]: model,
    [FIRST_TAB_DISCOUNT_HEADER]: "0",
    [WALLET_SPEND_LIMIT_HEADER]: "0",
  };

  let res: Response;
  try {
    res = await fetch(`${appUrl()}${ADMISSION_PATH}`, {
      method: "POST",
      headers,
      signal: opts.signal,
    });
  } catch (error) {
    // Transport failure: nothing committed server-side, retry is safe.
    return {
      ok: false,
      waitingRoom: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (res.status === 404 || res.status === 405) {
    return {
      ok: false,
      terminal: true,
      message: "This Codebuff server does not support Freebuff session admission.",
    };
  }

  return interpretAdmissionResponse(res, model);
}

const DEFAULT_MODEL_FALLBACK = "z-ai/glm-5.3-flash";

/** Release the slot when the turn is over (mirrors the CLI's exit path). */
export async function releaseFreebuffSession(opts: {
  token: string;
  instanceId: string;
  signal?: AbortSignal;
}): Promise<void> {
  try {
    await fetch(`${appUrl()}${SESSION_PATH}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        [INSTANCE_HEADER]: opts.instanceId,
      },
      signal: opts.signal,
    });
  } catch {
    // Best-effort; the server expires slots on its own.
  }
}

function safeTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
