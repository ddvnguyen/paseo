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
  releaseFreebuffSession,
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
 * Run one prompt turn against the Codebuff backend and translate the SDK's
 * print-mode event stream into ACP session updates.
 *
 * `session.run_state` from a previous run is passed back as `previousRun` to
 * continue the same conversation.
 */
export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const {
    client,
    cwd,
    prompt,
    content,
    previousRun,
    signal,
    emit: rawEmit,
    token,
    model,
    mcpServers,
    confirmSessionOpen,
    confirmModelSwitch,
  } = options;

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

  try {
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
      return admissionRefusal(admission, previousRun, emit);
    }

    try {
      // Adopt the open slot's model when admission reuses an existing free
      // session (catalog models differ per slot). Root agent id must match
      // that model or the backend rejects the run with model mismatch.
      const { runModel, agentId } = resolveAdmittedAgent(admission.model, model);
      if (!agentId) {
        // The admitted model has no bundled root definition. The model is
        // baked into the static AgentDefinition (client.run() has no
        // separate model field) — silently falling back to the GLM root
        // would run against a slot locked to a different model. Refuse
        // instead, inside this try so the finally below still releases a
        // slot we POST-claimed, exactly like the admission-failure path.
        emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text:
              `Freebuff admitted model "${runModel}" but no root agent is configured for it. ` +
              "Add it to FREEBUFF_AGENT_ID_BY_MODEL, or set FREEBUFF_AGENT_ID to override.",
          },
        });
        return {
          stopReason: "refusal",
          runState: previousRun,
        };
      }

      // The published @codebuff/sdk 0.10.7 lacks the upstream
      // `extraCodebuffMetadata` run option, so the adapter installs a tiny
      // runtime hook (see entry.ts) and feeds the admitted slot id through
      // it; newer SDKs pick the same value up via the official option.
      const globalWithHook = globalThis as typeof globalThis & {
        __freebuffExtraCodebuffMetadata?: Record<string, string>;
      };
      if (process.env.FREEBUFF_DISABLE_ADMISSION) {
        delete globalWithHook.__freebuffExtraCodebuffMetadata;
      } else {
        globalWithHook.__freebuffExtraCodebuffMetadata = {
          freebuff_instance_id: admission.instanceId,
        };
      }

      // Attach host + mcp.json MCP servers to every root definition so the
      // SDK discovers tools via AgentDefinition.mcpServers (run() does not
      // auto-load mcp.json).
      const agentDefinitions = (
        Object.keys(mcpServers ?? {}).length > 0
          ? FREEBUFF_ROOT_DEFINITIONS.map((def) => ({
              ...def,
              mcpServers: { ...def.mcpServers, ...mcpServers },
            }))
          : FREEBUFF_ROOT_DEFINITIONS
      ) as Parameters<CodebuffClient["run"]>[0]["agentDefinitions"];

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
        // Official option on newer SDKs; 0.10.7 also reads the globalThis hook.
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
        return { stopReason: "cancelled", runState: previousRun };
      }
      if (runState.output?.type === "error" && !cancelled && !signal.aborted) {
        // Never end a failed run silently: the host would show an idle agent
        // with no clue why.
        const reason = describeRunError(runState.output);
        process.stderr.write(`freebuff-acp: run failed: ${reason}\n`);
        emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Freebuff run failed: ${reason}` },
        });
      }
      return {
        ...turnResultFromRunState(runState, cancelled || signal.aborted),
        admittedModel: runModel,
        creditsUsed: turnStats.creditsUsed,
      };
    } finally {
      const globalWithHook = globalThis as typeof globalThis & {
        __freebuffExtraCodebuffMetadata?: Record<string, string>;
      };
      delete globalWithHook.__freebuffExtraCodebuffMetadata;
      // Only hand back a slot we claimed with POST. A reused open session
      // belongs to another holder (CLI / second adapter) — releasing it would
      // steal their slot and re-block the next prompt.
      if (!admission.reused) {
        // Await so the DELETE completes before the lane hands the next
        // queued turn the global metadata hook — keeps the next turn's GET
        // probe deterministic instead of racing this turn's release.
        await releaseFreebuffSession({
          token,
          instanceId: admission.instanceId,
          signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS),
        });
      }
    }
  } catch (error) {
    if (signal.aborted || cancelled) {
      return { stopReason: "cancelled", runState: previousRun };
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
