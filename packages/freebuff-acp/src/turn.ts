import type { StopReason } from "@agentclientprotocol/sdk";
import type { CodebuffClient, PrintModeEvent, RunState } from "@codebuff/sdk";

import { mapToolCallEvent, mapToolResultEvent } from "./tools.js";
import type { CodebuffMcpConfig } from "./mcp.js";
import {
  agentIdForModel,
  DEFAULT_FREEBUFF_MODEL,
  FREEBUFF_ROOT_DEFINITIONS,
} from "./freebuff-agent.js";
import { admitFreebuffSession, releaseFreebuffSession } from "./freebuff-session.js";

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
  previousRun: Record<string, unknown> | null;
  signal: AbortSignal;
  emit: SessionUpdateEmitter;
  /** Backend auth token used for the free-session admission dance. */
  token: string;
  /** Free-tier model id sent with the admission request. */
  model?: string;
  /** Host + mcp.json MCP servers to attach to the root agent definitions. */
  mcpServers?: Record<string, CodebuffMcpConfig>;
}

export interface TurnResult {
  stopReason: StopReason;
  runState: Record<string, unknown> | null;
}

/**
 * Translate the SDK print-mode event stream into ACP session updates.
 * Lives at module scope so `runTurn` keeps its lint complexity budget.
 */
function dispatchTurnEvent(event: PrintModeEvent, emit: SessionUpdateEmitter): void {
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
        mapToolCallEvent(event) as unknown as Record<string, unknown> & { sessionUpdate: string },
      );
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

/** Map a finished run's state to a TurnResult (run error → refusal, cancel honored). */
function turnResultFromRunState(runState: RunState, cancelled: boolean): TurnResult {
  const sessionState = (runState.sessionState ?? null) as Record<string, unknown> | null;
  if (runState.output?.type === "error") {
    // Preserve conversation state so the user can retry within the session.
    return { stopReason: "refusal", runState: sessionState };
  }
  if (cancelled) {
    return { stopReason: "cancelled", runState: sessionState };
  }
  return { stopReason: "end_turn", runState: sessionState };
}

/**
 * Run one prompt turn against the Codebuff backend and translate the SDK's
 * print-mode event stream into ACP session updates.
 *
 * `session.run_state` from a previous run is passed back as `previousRun` to
 * continue the same conversation.
 */
export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const { client, cwd, prompt, previousRun, signal, emit, token, model, mcpServers } = options;

  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const handleEvent = (event: PrintModeEvent) => dispatchTurnEvent(event, emit);

  try {
    // The CLI's free-mode protocol: hold a session slot BEFORE running.
    // Without the admitted instanceId the backend answers with
    // `waiting_room_required` even when a slot was available.
    const admission = await admitFreebuffSession({ token, model, signal });
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

      const runState: RunState = await client.run({
        agent: agentId,
        agentDefinitions,
        prompt,
        cwd,
        // 'free' = 0 credits charged for allowlisted Freebuff agents.
        costMode: "free",
        handleEvent,
        // Official option on newer SDKs; 0.10.7 also reads the globalThis hook.
        extraCodebuffMetadata: process.env.FREEBUFF_DISABLE_ADMISSION
          ? {}
          : { freebuff_instance_id: admission.instanceId },
        ...(previousRun ? { previousRun: previousRun as unknown as RunState } : {}),
        signal,
      } as Parameters<CodebuffClient["run"]>[0]);

      return turnResultFromRunState(runState, cancelled);
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
        await releaseFreebuffSession({ token, instanceId: admission.instanceId });
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
