import type { StopReason } from "@agentclientprotocol/sdk";
import type { CodebuffClient, PrintModeEvent, RunState } from "@codebuff/sdk";

import { mapToolCallEvent, mapToolResultEvent } from "./tools.js";

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
}

export interface TurnResult {
  stopReason: StopReason;
  runState: Record<string, unknown> | null;
}

/**
 * Run one prompt turn against the Codebuff backend and translate the SDK's
 * print-mode event stream into ACP session updates.
 *
 * `session.run_state` from a previous run is passed back as `previousRun` to
 * continue the same conversation.
 */
export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const { client, cwd, prompt, previousRun, signal, emit } = options;

  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const handleEvent = (event: PrintModeEvent) => {
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
  };

  try {
    const runState: RunState = await client.run({
      agent: "base",
      prompt,
      cwd,
      handleEvent,
      ...(previousRun ? { previousRun: previousRun as unknown as RunState } : {}),
      signal,
    });

    if (runState.output?.type === "error") {
      // Preserve conversation state so the user can retry within the session.
      return {
        stopReason: "refusal",
        runState: (runState.sessionState ?? null) as Record<string, unknown> | null,
      };
    }
    if (cancelled) {
      return {
        stopReason: "cancelled",
        runState: (runState.sessionState ?? null) as Record<string, unknown> | null,
      };
    }
    return {
      stopReason: "end_turn",
      runState: (runState.sessionState ?? null) as Record<string, unknown> | null,
    };
  } catch (error) {
    if (signal.aborted || cancelled) {
      return { stopReason: "cancelled", runState: previousRun };
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
