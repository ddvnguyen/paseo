import type { StopReason } from "@agentclientprotocol/sdk";
import type { CodebuffClient, MessageContent, PrintModeEvent, RunState } from "@codebuff/sdk";

import { toPreviousRun } from "./run-state.js";
import { todosToPlan } from "./plan.js";
import { mapToolCallEvent, mapToolResultEvent } from "./tools.js";
import type { CodebuffMcpConfig } from "./mcp.js";
import {
  agentIdForModel,
  DEFAULT_FREEBUFF_MODEL,
  FREEBUFF_ROOT_DEFINITIONS,
} from "./freebuff-agent.js";
import {
  admitFreebuffSession,
  probeSessionSeat,
  releaseFreebuffSession,
  type AdmissionResult,
  type ModelSwitchInfo,
  type SessionOpenInfo,
} from "./freebuff-session.js";

/**
 * Default free-mode model (env `FREEBUFF_MODEL`, default GLM 5.3 Flash).
 * Per-turn model still comes from admission: an already-open free session
 * may be locked to a different catalog model, which the run must adopt.
 */
const SELECTED_MODEL = process.env.FREEBUFF_MODEL?.trim() || DEFAULT_FREEBUFF_MODEL;

export type SessionUpdateEmitter = (
  update: Record<string, unknown> & { sessionUpdate: string },
) => void;

export interface RunTurnOptions {
  client: CodebuffClient;
  cwd: string;
  prompt: string;
  /** Multimodal prompt content (text + images); `prompt` stays the text fallback. */
  content?: MessageContent[];
  previousRun: Record<string, unknown> | null;
  signal: AbortSignal;
  emit: SessionUpdateEmitter;
  /** Backend auth token used for the free-session admission dance. */
  token: string;
  /** Free-tier model id sent with the admission request. */
  model?: string;
  /** Host + mcp.json MCP servers to attach to the root agent definitions. */
  mcpServers?: Record<string, CodebuffMcpConfig>;
  /**
   * Asked before the admission POST opens a NEW session (spends credit).
   * Omitted = auto-open; live-session reuse probes never consult it.
   * F1: also asked with `probeUnknown: true` when the seat probe failed —
   * a truthy answer is the explicit OK to claim blind.
   */
  confirmSessionOpen?: (info: SessionOpenInfo) => Promise<boolean>;
  /**
   * Asked when the account's single seat is held on another model. Approve =
   * end it and open the requested model; omitted/declined = run on the held one.
   */
  confirmModelSwitch?: (info: ModelSwitchInfo) => Promise<boolean>;
}

export interface TurnResult {
  stopReason: StopReason;
  runState: Record<string, unknown> | null;
  /** Model the admitted slot actually ran (may differ from the requested one). */
  admittedModel?: string;
  /** Conversation size in tokens after the turn, when the SDK reported it. */
  contextTokens?: number;
  /** Credits the turn consumed (0 for free-tier agents). */
  creditsUsed?: number;
}

/**
 * Translate the SDK print-mode event stream into ACP session updates.
 * Lives at module scope so `runTurn` keeps its lint complexity budget.
 */
function dispatchTurnEvent(
  event: PrintModeEvent,
  emit: SessionUpdateEmitter,
  cwd: string,
  turnStats: { creditsUsed: number },
): void {
  switch (event.type) {
    case "text": {
      if (event.text) {
        emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: event.text },
        });
      }
      break;
    }
    case "reasoning_delta": {
      if (event.text) {
        emit({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: event.text },
        });
      }
      break;
    }
    case "tool_call": {
      emit(
        mapToolCallEvent(event, cwd) as unknown as Record<string, unknown> & {
          sessionUpdate: string;
        },
      );
      if (event.toolName === "write_todos") {
        const plan = todosToPlan(event.input);
        if (plan) emit({ sessionUpdate: "plan", ...plan });
      }
      break;
    }
    case "subagent_start": {
      // Subagents have no dedicated ACP surface; show each as a thinking-style
      // tool call so hosts render a card that completes when it finishes.
      emit({
        sessionUpdate: "tool_call",
        toolCallId: `subagent-${event.agentId}`,
        title: `Subagent: ${event.displayName}`,
        kind: "think",
        status: "in_progress",
        ...(event.prompt ? { rawInput: { prompt: event.prompt } } : {}),
      });
      break;
    }
    case "subagent_finish": {
      emit({
        sessionUpdate: "tool_call_update",
        toolCallId: `subagent-${event.agentId}`,
        status: "completed",
      });
      break;
    }
    case "finish": {
      turnStats.creditsUsed += event.totalCost;
      break;
    }
    case "tool_result": {
      emit(
        mapToolResultEvent(event) as unknown as Record<string, unknown> & {
          sessionUpdate: string;
        },
      );
      break;
    }
    default:
      break;
  }
}

/** Emit the waiting-room/terminal admission failure and return a refusal result. */
function admissionRefusal(
  admission: { terminal?: true; message?: string },
  previousRun: Record<string, unknown> | null,
  emit: SessionUpdateEmitter,
): TurnResult {
  const reason = admission.message ?? "no free session slot";
  emit({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text:
        "terminal" in admission && admission.terminal
          ? `Freebuff admission failed: ${reason}`
          : `Freebuff is busy right now (waiting room): ${reason}. Try again shortly.`,
    },
  });
  return { stopReason: "refusal", runState: previousRun };
}

/**
 * Pick the run's root agent: the admitted slot's model wins (reused sessions
 * may be locked to a different catalog model), then FREEBUFF_AGENT_ID, then
 * the bundled model→agent map.
 */
function resolveAdmittedAgent(
  admittedModel: string | undefined,
  requestedModel: string | undefined,
): { runModel: string; agentId: string | null } {
  const runModel = admittedModel?.trim() || requestedModel || SELECTED_MODEL;
  const envAgentId = process.env.FREEBUFF_AGENT_ID?.trim();
  return { runModel, agentId: envAgentId || agentIdForModel(runModel) };
}

/** Best-effort human-readable text for an SDK run error. */
function describeRunError(output: unknown): string {
  const message = (output as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim() ? message.trim() : "unknown error";
}

/**
 * The Freebuff gate codes that END the session (upstream
 * `FREEBUFF_GATE_CODES` with `endsTheSession: true`): the account's seat is
 * gone or unusable for this run. `session_limit_reached` (409),
 * `waiting_room_queued` (429) and `model_unavailable` (410) deliberately do
 * NOT end the session, so they must never trigger a re-admission here.
 */
export const SESSION_END_GATE_CODES = {
  waiting_room_required: 428,
  session_expired: 410,
  session_superseded: 409,
  session_model_mismatch: 409,
} as const;

export type SessionEndGateCode = keyof typeof SESSION_END_GATE_CODES;

/**
 * Extract the upstream gate rejection from a finished run's output, matching
 * code AND status (mirrors upstream `getFreebuffGateCode`). The relayed gate
 * error surfaces in two places depending on SDK build: top-level
 * `output.error` + `output.statusCode`, or embedded in the error `message`
 * as a JSON payload `{"error":code,"statusCode":N}`.
 */
export function gateCodeFromRunState(runState: {
  output?: { type?: string; error?: unknown; statusCode?: unknown; message?: unknown } | null;
}): SessionEndGateCode | null {
  const output = runState.output;
  if (!output || typeof output !== "object") return null;
  const candidates: Array<{ error?: unknown; statusCode?: unknown }> = [
    { error: output.error, statusCode: output.statusCode },
  ];
  if (typeof output.message === "string") {
    const start = output.message.indexOf("{");
    const end = output.message.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const parsed: unknown = JSON.parse(output.message.slice(start, end + 1));
        if (parsed && typeof parsed === "object") {
          const body = parsed as { error?: unknown; statusCode?: unknown };
          candidates.push({ error: body.error, statusCode: body.statusCode });
        }
      } catch {
        // Not a JSON payload; no embedded gate error.
      }
    }
  }
  for (const candidate of candidates) {
    const code = candidate.error;
    if (typeof code !== "string" || !Object.hasOwn(SESSION_END_GATE_CODES, code)) continue;
    const expected = SESSION_END_GATE_CODES[code as SessionEndGateCode];
    if (candidate.statusCode === expected) return code as SessionEndGateCode;
  }
  return null;
}

/** Map a finished run's state to a TurnResult (run error → refusal, cancel honored). */
function turnResultFromRunState(runState: RunState, cancelled: boolean): TurnResult {
  const sessionState = (runState.sessionState ?? null) as Record<string, unknown> | null;
  const contextTokens = runState.sessionState?.mainAgentState?.contextTokenCount;
  const usage = typeof contextTokens === "number" ? { contextTokens } : {};
  // Cancel wins over error: the SDK reports an aborted run as
  // `output.type === "error"`, which must surface as a user stop (host
  // `turn_canceled`), not as a refused/completed turn.
  if (cancelled) {
    return { stopReason: "cancelled", runState: sessionState, ...usage };
  }
  if (runState.output?.type === "error") {
    // Preserve conversation state so the user can retry within the session.
    return { stopReason: "refusal", runState: sessionState, ...usage };
  }
  return { stopReason: "end_turn", runState: sessionState, ...usage };
}

/**
 * How long a cancelled turn waits for the SDK run to unwind on its own (so
 * partial conversation state is kept) before the turn is settled anyway. The
 * SDK does not abort every in-flight tool, so an unbounded wait would leave
 * the host's stop/steer hanging and wedge the process-wide turn lane.
 */
const CANCEL_GRACE_MS = 1_500;
/** Upper bound for the best-effort slot release so it never stalls a cancel. */
const RELEASE_TIMEOUT_MS = 3_000;

/**
 * Await `run`, but settle promptly once `signal` aborts: give the run
 * CANCEL_GRACE_MS to return its own (partial) state, else report `null`.
 * The orphaned run keeps going in the background; its result is discarded.
 */
async function awaitRunOrAbort(
  run: Promise<RunState>,
  signal: AbortSignal,
): Promise<RunState | null> {
  // Never leave an orphaned run's rejection unhandled.
  run.catch(() => undefined);
  if (signal.aborted) {
    return raceGrace(run);
  }
  const abortedFirst = new Promise<"aborted">((resolve) => {
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  const first = await Promise.race([run, abortedFirst]);
  return first === "aborted" ? raceGrace(run) : first;
}

async function raceGrace(run: Promise<RunState>): Promise<RunState | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CANCEL_GRACE_MS);
  });
  try {
    return await Promise.race([run.catch(() => null), grace]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * F2 — process-wide seat registry (module-global singleton: the ACP adapter
 * process has one turn lane, so a single mutable map is the atomic source of
 * truth). Tracks every instanceId whose lifecycle this process owns:
 *  - "claimed": opened by this process's admission POST (must be released).
 *  - "adopted": instanceId seen live on a pre-POST probe and being reused
 *    right now by exactly one turn — another turn adopting it too would
 *    supersede the first run and release a live session out from under it.
 * `adoptAdmittedSeatAtomically` does check-and-mark with no await in between,
 * so two concurrent turns can never both adopt (or adopt-then-release) one seat.
 */
interface SeatRecord {
  state: "claimed" | "adopted";
  /** The turn (lane) currently holding the seat, for adopt/release symmetry. */
  holder: symbol;
  /** Kept for claimed seats so an idle one can be released at shutdown. */
  token?: string;
}

const seatRegistry = new Map<string, SeatRecord>();

/** Registry holder for seats recovered after a lost POST response (F3). */
const SEAT_RECOVERY_HOLDER = Symbol("freebuff-seat-recovery");

function releaseSeat(instanceId: string, holder: symbol): void {
  const record = seatRegistry.get(instanceId);
  if (record && record.holder === holder) seatRegistry.delete(instanceId);
}

/**
 * F2 — single atomic check-and-mark step. `admission` and `transition` run
 * synchronously (no await between seatRegistry read and write), so the
 * event loop cannot interleave another turn's transition between them.
 */
function adoptAdmittedSeatAtomically(
  admission: { instanceId: string; reused: boolean },
  holder: symbol,
  token: string,
): { adopt: boolean; conflict?: string } {
  if (!admission.reused) {
    seatRegistry.set(admission.instanceId, { state: "claimed", holder, token });
    return { adopt: true };
  }
  const record = seatRegistry.get(admission.instanceId);
  if (!record) {
    // Reused seat nobody here runs against (e.g. the CLI opened it): adopt
    // it for this turn, but it is NOT ours to release afterwards.
    seatRegistry.set(admission.instanceId, { state: "adopted", holder });
    return { adopt: true };
  }
  if (record.state === "claimed" && record.holder === SEAT_RECOVERY_HOLDER) {
    // F3: orphaned seat from a lost POST response — take it over so this
    // turn's release path deletes it when done.
    seatRegistry.set(admission.instanceId, { state: "claimed", holder, token });
    return { adopt: true };
  }
  return {
    adopt: false,
    conflict:
      record.state === "claimed"
        ? "already claimed by a concurrent turn"
        : "already adopted by a concurrent turn",
  };
}

/**
 * F3 — recovery after a lost admission POST response. The POST may have
 * committed a new seat server-side even though this adapter never saw it.
 * One extra probe: an `active` seat that this adapter did not hold before is
 * registered as "claimed by us" so a later turn reusing it adopts it as its
 * own and the release path deletes it.
 */
async function recoverOrphanedSeat(token: string, signal: AbortSignal): Promise<void> {
  try {
    const { probe } = await probeSessionSeat(token, signal);
    if (probe?.status === "active" && probe.instanceId && !seatRegistry.has(probe.instanceId)) {
      // Nothing here held it before: it came from the lost POST — ours to clean up.
      seatRegistry.set(probe.instanceId, {
        state: "claimed",
        holder: SEAT_RECOVERY_HOLDER,
        token,
      });
    }
  } catch {
    // Best-effort: the server expires seats on their own.
  }
}

/**
 * Handle a failed admission (F1/F3/F4): a cancelled flow maps to a cancelled
 * turn, an unknown seat surfaces the probe failure, a lost POST response
 * triggers the one-shot orphaned-seat probe, and everything else is the
 * standard waiting-room/terminal refusal message.
 */
async function admissionFailure(
  admission: Exclude<AdmissionResult, { ok: true }>,
  previousRun: Record<string, unknown> | null,
  emit: SessionUpdateEmitter,
  token: string,
  signal: AbortSignal,
): Promise<TurnResult> {
  if ("cancelled" in admission && admission.cancelled) {
    // F4: the caller aborted the admission flow — surface the user's
    // stop, not a refusal ("Freebuff is busy") that misreports it.
    return { stopReason: "cancelled", runState: previousRun };
  }
  if ("unknownSeat" in admission && admission.unknownSeat) {
    // F1: seat probe failed (network/timeout/non-OK). Never claim
    // blindly and never report "no active session" — surface the
    // unknown-seat error and preserve conversation state for a retry.
    const reason = admission.message ?? "seat probe failed";
    emit({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text:
          `Freebuff could not determine the seat state: ${reason}. ` +
          "A free session may already be open on this account, so no new one was started. Try again shortly.",
      },
    });
    return { stopReason: "refusal", runState: previousRun };
  }
  if ("responseLost" in admission && admission.responseLost) {
    // F3: the POST may have committed server-side despite the lost
    // response; probe once and register the seat as claimed by us so a
    // later turn that reuses it releases it.
    await recoverOrphanedSeat(token, signal);
  }
  return admissionRefusal(admission, previousRun, emit);
}

/** F2: a concurrent turn already holds the admitted seat — refuse quietly. */
function seatConflictRefusal(
  admission: { instanceId: string },
  conflict: string | undefined,
  emit: SessionUpdateEmitter,
  previousRun: Record<string, unknown> | null,
): TurnResult {
  emit({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text:
        `Freebuff seat ${admission.instanceId} is ${conflict ?? "in use"}; ` +
        "waiting for that turn to finish before starting another.",
    },
  });
  return { stopReason: "refusal", runState: previousRun };
}

/** The admitted model has no bundled root definition — refuse, no fallback. */
function missingAgentRefusal(
  runModel: string,
  emit: SessionUpdateEmitter,
  previousRun: Record<string, unknown> | null,
): TurnResult {
  emit({
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text:
        `Freebuff admitted model "${runModel}" but no root agent is configured for it. ` +
        "Add it to FREEBUFF_AGENT_ID_BY_MODEL, or set FREEBUFF_AGENT_ID to override.",
    },
  });
  return { stopReason: "refusal", runState: previousRun };
}

/**
 * Attach host + mcp.json MCP servers to every root definition so the
 * SDK discovers tools via AgentDefinition.mcpServers (run() does not
 * auto-load mcp.json).
 */
function attachMcpServers(
  mcpServers: Record<string, CodebuffMcpConfig> | undefined,
): NonNullable<Parameters<CodebuffClient["run"]>[0]["agentDefinitions"]> {
  return (
    Object.keys(mcpServers ?? {}).length > 0
      ? FREEBUFF_ROOT_DEFINITIONS.map((def) => ({
          ...def,
          mcpServers: { ...def.mcpServers, ...mcpServers },
        }))
      : FREEBUFF_ROOT_DEFINITIONS
  ) as NonNullable<Parameters<CodebuffClient["run"]>[0]["agentDefinitions"]>;
}

/**
 * Never end a failed run silently: log it and tell the host why. Skipped
 * when the turn was stopped — cancel wins over error.
 */
function reportRunError(runState: RunState, stopped: boolean, emit: SessionUpdateEmitter): void {
  if (runState.output?.type !== "error" || stopped) return;
  const reason = describeRunError(runState.output);
  process.stderr.write(`freebuff-acp: run failed: ${reason}\n`);
  emit({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `Freebuff run failed: ${reason}` },
  });
}

/**
 * F2: only the turn holding the registry record may release the seat, and
 * only a POST-claimed one is deleted — a reused open session belongs to its
 * previous holder (CLI / second adapter); releasing it would steal their
 * slot and re-block the next prompt. Awaited so the DELETE completes before
 * the lane starts the next queued turn — keeps the next turn's GET probe
 * deterministic instead of racing this turn's release.
 *
 * `keepSeat`: a seat that just served a real run stays open (valid for an
 * hour, 5 Freebucks to open) so the next prompt reuses it instead of asking
 * to open — and pay for — another one. It is parked as an idle claimed seat
 * (recovery holder) that the next turn re-adopts. Nothing releases it at
 * shutdown: another agent may have taken the seat over in the meantime, and
 * a DELETE could end a session this process no longer owns. The seat simply
 * expires after its hour, or is ended via the plugin's End session button.
 */
async function releaseAdmittedSeat(
  token: string,
  admission: { instanceId: string },
  holder: symbol,
  keepSeat: boolean,
): Promise<void> {
  const record = seatRegistry.get(admission.instanceId);
  if (record?.holder !== holder) return;
  if (record.state === "claimed" && keepSeat) {
    seatRegistry.set(admission.instanceId, {
      state: "claimed",
      holder: SEAT_RECOVERY_HOLDER,
      token,
    });
    return;
  }
  releaseSeat(admission.instanceId, holder);
  if (record.state !== "claimed") return;
  await releaseFreebuffSession({
    token,
    instanceId: admission.instanceId,
    signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
  });
}

interface AdmittedTurnContext {
  seatHolder: symbol;
  turnStats: { creditsUsed: number };
  /** True once the caller's abort signal fired (cancel wins over gate retry). */
  stopped(): boolean;
  /** False on the final attempt: a gate failure there is reported normally. */
  allowGateRetry: boolean;
}

type AdmittedTurnOutcome = { retryAfterGate: false; result: TurnResult } | { retryAfterGate: true };

/**
 * One admission + run attempt. On a session-end gate rejection
 * (`endsTheSession` codes: seat expired / superseded / model mismatch /
 * waiting room) the seat is worthless — release the registry record and ask
 * the caller to re-admit and retry the same prompt once.
 */
async function runAdmittedTurn(
  options: RunTurnOptions,
  emit: SessionUpdateEmitter,
  handleEvent: (event: PrintModeEvent) => void,
  handleStreamChunk: unknown,
  context: AdmittedTurnContext,
): Promise<AdmittedTurnOutcome> {
  const {
    client,
    cwd,
    prompt,
    content,
    previousRun,
    signal,
    token,
    model,
    mcpServers,
    confirmSessionOpen,
    confirmModelSwitch,
  } = options;

  // The CLI's free-mode protocol: hold a session slot BEFORE running.
  // Without the admitted instanceId the backend answers with
  // `waiting_room_required` even when a slot was available.
  const admission = await admitFreebuffSession({
    token,
    model,
    signal,
    confirmOpen: confirmSessionOpen,
    confirmSwitch: confirmModelSwitch,
  });
  if (!admission.ok) {
    return {
      retryAfterGate: false,
      result: await admissionFailure(admission, previousRun, emit, token, signal),
    };
  }

  // F2 — atomic adopt: re-check the registry and mark the seat as ours in
  // one synchronous step so two concurrent turns can never both adopt (or
  // release) the same seat.
  const adoption = adoptAdmittedSeatAtomically(admission, context.seatHolder, token);
  if (!adoption.adopt) {
    return {
      retryAfterGate: false,
      result: seatConflictRefusal(admission, adoption.conflict, emit, previousRun),
    };
  }

  let seatServedRun = false;
  try {
    // Adopt the open slot's model when admission reuses an existing free
    // session (catalog models differ per slot). Root agent id must match
    // that model or the backend rejects the run with model mismatch.
    const { runModel, agentId } = resolveAdmittedAgent(admission.model, model);
    if (!agentId) {
      // The model is baked into the static AgentDefinition (client.run()
      // has no separate model field) — silently falling back to the GLM
      // root would run against a slot locked to a different model. Refuse
      // inside this try so the finally below still releases a slot we
      // POST-claimed, exactly like the admission-failure path.
      return {
        retryAfterGate: false,
        result: missingAgentRefusal(runModel, emit, previousRun),
      };
    }

    const agentDefinitions = attachMcpServers(mcpServers);

    seatServedRun = true;
    const run = client.run({
      agent: agentId,
      agentDefinitions,
      prompt,
      ...(content && content.length > 0 ? { content } : {}),
      cwd,
      // 'free' = 0 credits charged for allowlisted Freebuff agents.
      costMode: "free",
      handleEvent,
      handleStreamChunk,
      // Per-run option of the fork SDK (no process-global state).
      extraCodebuffMetadata: process.env.FREEBUFF_DISABLE_ADMISSION
        ? {}
        : { freebuff_instance_id: admission.instanceId },
      ...(previousRun ? { previousRun: toPreviousRun(previousRun) as unknown as RunState } : {}),
      signal,
    } as Parameters<CodebuffClient["run"]>[0]);

    const runState = await awaitRunOrAbort(run, signal);
    if (!runState) {
      // Stopped and the SDK did not unwind in time (e.g. a tool that ignores
      // the signal): settle now with the pre-turn conversation state.
      return {
        retryAfterGate: false,
        result: { stopReason: "cancelled", runState: previousRun },
      };
    }
    const stopped = context.stopped();
    if (!stopped && runState.output?.type === "error") {
      const gateCode = gateCodeFromRunState(runState);
      if (gateCode) {
        // R3: the seat is gone (expired, superseded by another agent, or
        // ended from the plugin UI). Never surface "free session has ended":
        // drop the registry record (the seat is dead regardless of who held
        // it) and re-admit — the caller retries the same prompt once.
        seatRegistry.delete(admission.instanceId);
        if (context.allowGateRetry) return { retryAfterGate: true };
        // Last attempt also hit the gate: fall through and report the
        // failure normally instead of retrying forever.
      }
    }
    reportRunError(runState, stopped, emit);
    return {
      retryAfterGate: false,
      result: {
        ...turnResultFromRunState(runState, stopped),
        admittedModel: runModel,
        creditsUsed: context.turnStats.creditsUsed,
      },
    };
  } finally {
    await releaseAdmittedSeat(token, admission, context.seatHolder, seatServedRun);
  }
}

/**
 * Run one prompt turn against the Codebuff backend and translate the SDK's
 * print-mode event stream into ACP session updates.
 *
 * `session.run_state` from a previous run is passed back as `previousRun` to
 * continue the same conversation.
 */
export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const { cwd, previousRun, signal, emit: rawEmit } = options;

  // A stopped turn must go quiet: an orphaned run may still stream events
  // after the host has already been told the turn was cancelled.
  const emit: SessionUpdateEmitter = (update) => {
    if (!signal.aborted) rawEmit(update);
  };

  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
  };
  signal.addEventListener("abort", onAbort, { once: true });

  // The SDK splits live output across two callbacks: text deltas arrive as
  // strings on handleStreamChunk (reasoning as reasoning_chunk objects), while
  // handleEvent only receives that same text later, flushed as one {type:"text"}
  // event at tool boundaries / message end — which is why replies rendered in
  // one late block. Stream deltas immediately, remember what was streamed, and
  // drop a flush that repeats already-sent text so nothing renders twice. A
  // run with no deltas keeps the flush path unchanged.
  let streamedText = "";
  const turnStats = { creditsUsed: 0 };
  const handleEvent = (event: PrintModeEvent) => {
    if (event.type === "text" && event.text && streamedText.endsWith(event.text)) {
      return;
    }
    dispatchTurnEvent(event, emit, cwd, turnStats);
  };
  const handleStreamChunk = (
    chunk: Parameters<NonNullable<Parameters<CodebuffClient["run"]>[0]["handleStreamChunk"]>>[0],
  ) => {
    if (typeof chunk === "string") {
      if (chunk) {
        streamedText += chunk;
        emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        });
      }
      return;
    }
    if (chunk.type === "reasoning_chunk" && chunk.chunk) {
      emit({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: chunk.chunk },
      });
      return;
    }
    // subagent_chunk: subagents have no ACP surface; keep the pre-existing drop.
  };

  // F2 — this turn's seat-holder identity for registry symmetry.
  const seatHolder = Symbol("freebuff-seat-holder");

  try {
    // Up to two attempts: the first run can be rejected by a session gate
    // (expired / superseded / model mismatch / waiting room) because the
    // account's seat died mid-session. Like upstream, forget the dead window
    // and re-admit through the normal path, then retry the SAME prompt once
    // with the same previousRun so the conversation continues.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Freebuff session ended; reopened and continuing.",
          },
        });
      }
      const turn = await runAdmittedTurn(options, emit, handleEvent, handleStreamChunk, {
        seatHolder,
        turnStats,
        stopped: () => cancelled || signal.aborted,
        allowGateRetry: attempt === 0,
      });
      if (!turn.retryAfterGate) return turn.result;
    }
    // Unreachable: only the first attempt may request a gate retry.
    throw new Error("unreachable: gate retry loop exhausted");
  } catch (error) {
    if (signal.aborted || cancelled) {
      return { stopReason: "cancelled", runState: previousRun };
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
