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

/** Cap for admission calls whose caller has no deadline of their own (F4). */
const ADMISSION_TIMEOUT_MS = 15_000;

function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_CODEBUFF_APP_URL ||
    process.env.CODEBUFF_APP_URL ||
    "https://www.codebuff.com"
  ).replace(/\/$/, "");
}

/**
 * Probe outcome (F1): `{unknown: false}` means the GET answered — `probe` is
 * the server response, or `null` when no live seat is held. `{unknown: true}`
 * means the probe itself failed (network/timeout/non-OK) so seat presence is
 * UNKNOWN — never conflated with "no seat": the caller asks via its confirm
 * path or surfaces an error instead of silently claiming a new slot that
 * could supersede a live one.
 */
export type SeatProbeResult =
  | { unknown: false; probe: FreebuffSessionServerResponse | null }
  | { unknown: true; probe: null; message?: string };

export type AdmissionResult =
  | { ok: true; instanceId: string; model: string; accessTier?: string; reused: boolean }
  | {
      ok: false;
      waitingRoom: true;
      message?: string;
      /** F3: the POST timed out after send — a seat may exist server-side. */
      responseLost?: true;
    }
  | { ok: false; terminal: true; message: string }
  /** F1: seat presence unknown; `unknownSeat: true` tells the caller to ask or surface an error. */
  | { ok: false; unknownSeat: true; message: string }
  /** F4: caller aborted the admission flow; map to cancelled, not refusal. */
  | { ok: false; cancelled: true; message: string };

/** What the host approves before ending another holder's session to switch model. */
export interface ModelSwitchInfo {
  /** Model of the session the account already holds (shared with other agents/CLIs). */
  currentModel: string;
  requestedModel: string;
  /** Catalog price of one hour on `requestedModel`, when the probe reported it. */
  priceFreebucks?: number;
  dailyRemaining?: number;
}

/** What the host approves before a credit-spending session open. */
export interface SessionOpenInfo {
  model: string;
  /** Catalog price of one hour on `model`, when the probe reported it. */
  priceFreebucks?: number;
  /** Freebucks left in the daily pool, when the probe reported it. */
  dailyRemaining?: number;
  /** F1: the seat probe failed — seat presence is unknown, not empty. */
  probeUnknown?: boolean;
  /** Why the probe outcome is unknown (transport/HTTP failure text). */
  message?: string;
}

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    [TIMEZONE_HEADER]: safeTimezone(),
  };
}

/** F4: caller's deadline (if any) combined with the 15s admission-call cap. */
function admissionSignal(signal?: AbortSignal): AbortSignal | undefined {
  if (signal) return AbortSignal.any([signal, AbortSignal.timeout(ADMISSION_TIMEOUT_MS)]);
  return AbortSignal.timeout(ADMISSION_TIMEOUT_MS);
}

/** True when `signal` (the caller's) fired before the request did. */
function abortedByCaller(signal: AbortSignal | undefined): boolean {
  return !!signal?.aborted;
}

/** True for network/timeout aborts of the per-call deadline signal (F3). */
function isTimeoutAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Probe for a live slot and the account's quota/prices (GET), reporting the
 * F1 tri-state: `{probe: X, unknown: false}` when the GET answered (X =
 * response or `null` for no seat), `{unknown: true}` when it failed — the
 * caller must then ask or surface an error instead of silently claiming a
 * new seat. Throws only when the CALLER's own signal aborted (F4).
 */
export async function probeSessionSeat(
  token: string,
  signal?: AbortSignal,
): Promise<SeatProbeResult> {
  try {
    const res = await fetch(`${appUrl()}${SESSION_PATH}`, {
      method: "GET",
      headers: baseHeaders(token),
      signal: admissionSignal(signal),
    });
    if (!res.ok) {
      // F1: a non-OK probe is not "no seat" — seat state is unknown.
      return {
        unknown: true,
        probe: null,
        message: `Freebuff seat probe failed with HTTP ${res.status}.`,
      };
    }
    const body = (await res.json().catch(() => null)) as FreebuffSessionServerResponse | null;
    return { unknown: false, probe: body };
  } catch (error) {
    if (abortedByCaller(signal)) throw error;
    // F1: network/timeout failure — unknown seat, not empty.
    return {
      unknown: true,
      probe: null,
      message:
        error instanceof Error
          ? `Freebuff seat probe failed: ${error.message}`
          : `Freebuff seat probe failed: ${String(error)}`,
    };
  }
}

/**
 * Legacy non-fatal probe (GET; quota/prices for other callers): a failed or
 * unknown probe collapses to `null`, exactly as before F1. The admission
 * path uses `probeSessionSeat` instead, which keeps unknown distinct.
 */
export async function probeOpenSession(
  token: string,
  signal?: AbortSignal,
): Promise<FreebuffSessionServerResponse | null> {
  try {
    const result = await probeSessionSeat(token, signal);
    return result.unknown ? null : result.probe;
  } catch {
    // Probe failures are non-fatal here; fall through.
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

/** Fail closed: never spend credit when consent cannot be obtained. */
async function askOpenConsent(
  confirmOpen: (info: SessionOpenInfo) => Promise<boolean>,
  probe: FreebuffSessionServerResponse | null,
  model: string,
): Promise<boolean> {
  try {
    return await confirmOpen({
      model,
      priceFreebucks: probe?.freebucks?.prices?.[model],
      dailyRemaining: probe?.freebucks?.daily?.remaining,
    });
  } catch {
    return false;
  }
}

/**
 * The account holds one seat, on another model: ask the host, and on approval
 * end it (like the CLI: DELETE by instance id, then POST the new model).
 * Returns whether the seat was ended. Declined, unanswerable or no hook = keep.
 */
async function endHeldSeatIfSwitching(
  opts: {
    token: string;
    signal?: AbortSignal;
    confirmSwitch?: (info: ModelSwitchInfo) => Promise<boolean>;
  },
  probe: FreebuffSessionServerResponse | null,
  model: string,
): Promise<boolean> {
  const heldModel = probe?.model?.trim();
  if (
    probe?.status !== "active" ||
    !probe.instanceId ||
    !heldModel ||
    heldModel === model ||
    !opts.confirmSwitch
  ) {
    return false;
  }
  let approved = false;
  try {
    approved = await opts.confirmSwitch({
      currentModel: heldModel,
      requestedModel: model,
      priceFreebucks: probe.freebucks?.prices?.[model],
      dailyRemaining: probe.freebucks?.daily?.remaining,
    });
  } catch {
    // Fail closed: never end someone's session without an answer.
    approved = false;
  }
  if (approved) {
    await releaseFreebuffSession({
      token: opts.token,
      instanceId: probe.instanceId,
      signal: opts.signal,
    });
  }
  return approved;
}

/** F4: shared "cancelled by the caller" admission outcome. */
function cancelledAdmission(): AdmissionResult {
  return {
    ok: false,
    cancelled: true,
    message: "Freebuff session admission was cancelled.",
  };
}

/** F1: shared unknown-seat outcome (never claims, never reports "no session"). */
function unknownSeatAdmission(message: string | undefined): AdmissionResult {
  return {
    ok: false,
    unknownSeat: true,
    message: message ?? "Freebuff seat probe failed.",
  };
}

/**
 * F1 gate: when the probe outcome is unknown, never claim a session silently
 * and never report "no active session". With a confirm hook, an explicit
 * approval is the only way past; a decline, an unanswerable request, or no
 * hook reports `unknownSeat`. Returns null when the probe answered.
 */
async function handleUnknownProbe(
  opts: { confirmOpen?: (info: SessionOpenInfo) => Promise<boolean> },
  probeResult: SeatProbeResult,
  model: string,
): Promise<AdmissionResult | null> {
  if (!probeResult.unknown) return null;
  if (!opts.confirmOpen) return unknownSeatAdmission(probeResult.message);
  let approved = false;
  try {
    approved = await opts.confirmOpen({
      model,
      probeUnknown: true,
      message: probeResult.message,
    });
  } catch {
    approved = false;
  }
  return approved ? null : unknownSeatAdmission(probeResult.message);
}

/** Reuse result for a live slot already held by this account (never a block). */
function reusedSeatResult(
  probe: FreebuffSessionServerResponse,
  instanceId: string,
  model: string,
): AdmissionResult {
  return {
    ok: true,
    instanceId,
    // Prefer the slot's model (runs must match `x-freebuff-model`); if the
    // probe omitted it, keep the requested model.
    model: probe.model?.trim() || model,
    accessTier: probe.accessTier,
    reused: true,
  };
}

/**
 * Consent gate before a credit-spending POST. Reused slots and approved
 * switches never reach it; unknown probes already asked above (an approval
 * there covers the blind claim, so the host is not asked twice).
 */
async function openConsentDeclined(
  opts: { confirmOpen?: (info: SessionOpenInfo) => Promise<boolean> },
  probeResult: SeatProbeResult,
  switchApproved: boolean,
  probe: FreebuffSessionServerResponse | null,
  model: string,
): Promise<boolean> {
  return (
    !!opts.confirmOpen &&
    !switchApproved &&
    !probeResult.unknown &&
    !(await askOpenConsent(opts.confirmOpen, probe, model))
  );
}

/**
 * The admission POST itself: send it, map transport failures (F4 cancelled,
 * F3 response-lost timeout, other transport errors), then interpret the
 * response into the typed AdmissionResult.
 */
async function claimAdmission(
  opts: { token: string; signal?: AbortSignal },
  model: string,
): Promise<AdmissionResult> {
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
      signal: admissionSignal(opts.signal),
    });
  } catch (error) {
    // F4: the caller aborted the flow — that is a cancelled turn, not a
    // refusal ("Freebuff is busy") that would misreport the user's stop.
    if (abortedByCaller(opts.signal)) return cancelledAdmission();
    if (isTimeoutAbort(error)) {
      // F3: the POST may have committed server-side even though we never saw
      // the response. Mark the possible orphaned seat for later release.
      return {
        ok: false,
        waitingRoom: true,
        responseLost: true,
        message: `Admission POST timed out after ${ADMISSION_TIMEOUT_MS}ms.`,
      };
    }
    // Other transport failure: nothing provably committed server-side.
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

/**
 * Hold a free-session slot for `model`.
 *
 * Protocol order matters: GET first so a slot already held by this account
 * (another adapter instance, or the CLI) is reused instead of superseded.
 * POST is only sent when the probe confirmed nothing live is held. A failed
 * probe yields `unknownSeat` — the host decides via `confirmOpen`, and only
 * an explicit approval may claim blindly; otherwise the caller surfaces the
 * error. `model_locked` from a deliberate pick means a live session on
 * another model exists — reported as a waiting-room-style retryable state
 * with its message.
 */
export async function admitFreebuffSession(opts: {
  token: string;
  model?: string;
  signal?: AbortSignal;
  /**
   * Host consent hook. Asked only when no live slot was confirmed by the
   * probe (POST = credit spend). F1: after an unknown probe outcome this is
   * asked with `probeUnknown: true` — the host must explicitly approve
   * claiming blind; decline or omission reports `unknownSeat` instead.
   */
  confirmOpen?: (info: SessionOpenInfo) => Promise<boolean>;
  /**
   * The account has ONE seat, already held on another model. Asked before the
   * seat is ended to switch (the CLI's "End your active session to switch?").
   * Omitted or declined = keep the held seat and run on its model.
   */
  confirmSwitch?: (info: ModelSwitchInfo) => Promise<boolean>;
}): Promise<AdmissionResult> {
  const model = opts.model?.trim() || DEFAULT_MODEL_FALLBACK;

  // 1. Probe: reuse a live slot when one exists.
  let probeResult: SeatProbeResult;
  try {
    probeResult = await probeSessionSeat(opts.token, opts.signal);
  } catch {
    // Caller aborted the flow: report cancelled, not a refusal (F4).
    return cancelledAdmission();
  }

  const unknownGate = await handleUnknownProbe(opts, probeResult, model);
  if (unknownGate) return unknownGate;

  const probe = probeResult.unknown ? null : probeResult.probe;
  const switchApproved = await endHeldSeatIfSwitching(opts, probe, model);

  if (!switchApproved && probe?.status === "active" && probe.instanceId) {
    // An already-open free session is never a hard block. Returning ok lets
    // the turn adopt the open instance instead of parking the prompt in the
    // waiting room.
    return reusedSeatResult(probe, probe.instanceId, model);
  }

  // 2. Nothing confirmed live: the POST below opens a NEW 1-hour slot that
  // costs credit. Ask the host first — decline (or an unanswerable request)
  // means no spend. An approved switch already showed the price.
  if (await openConsentDeclined(opts, probeResult, switchApproved, probe, model)) {
    return {
      ok: false,
      terminal: true,
      message: "New free-session open was declined in the host — no credit spent.",
    };
  }

  // 3. Admission POST.
  return claimAdmission(opts, model);
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
      signal: admissionSignal(opts.signal),
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
