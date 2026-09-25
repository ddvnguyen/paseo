/**
 * Context-window usage for the host, as the standard ACP `usage_update`.
 *
 * `used` is the SDK's `contextTokenCount` for the conversation; `size` is the
 * model's context window, taken from the same table the Freebuff CLI uses for
 * its own status bar so both show the same percentage.
 */
import type { ReplayUpdate } from "./history-replay.js";

/**
 * Mirror of FREEBUFF_MODEL_CONTEXT_WINDOWS in the Freebuff CLI
 * (common/src/constants/freebuff-models.ts, external/freebuff submodule).
 * Those numbers are observed or published limits, entered on the safe (low)
 * side. Re-sync when the CLI adds a model.
 */
const CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  "minimax/minimax-m3": 524_288,
  "deepseek/deepseek-v4-flash": 1_048_576,
  "deepseek/deepseek-v4-pro": 1_048_576,
  "openai/gpt-5.6-luna": 1_000_000,
  "openai/gpt-6-luna": 1_000_000,
  "openai/gpt-5.6-luna-es": 372_000,
  "meta/muse-spark-1.2-contributor": 1_000_000,
  "stealth/ox-alpha": 1_000_000,
  "z-ai/glm-5.3-flash": 1_000_000,
  "upstage/solar-pro4": 500_000,
  "upstage/solar-mini4": 500_000,
  "stealth/space-bunny-alpha": 1_000_000,
};

/** The CLI's assumption for models missing from the table (smaller than every measured window). */
const DEFAULT_CONTEXT_WINDOW_TOKENS = 131_072;

export function contextWindowFor(modelId: string): number {
  return CONTEXT_WINDOW_TOKENS[modelId] ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/** The conversation's context token count from a persisted/finished RunState, if recorded. */
export function contextTokensOf(runState: Record<string, unknown> | null): number | undefined {
  const mainAgentState = runState?.mainAgentState as { contextTokenCount?: unknown } | undefined;
  const tokens = mainAgentState?.contextTokenCount;
  return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined;
}

/** `usage_update` for the session's current context, or null when no count is recorded. */
export function contextUsageUpdate(
  runState: Record<string, unknown> | null,
  modelId: string,
): ReplayUpdate | null {
  const used = contextTokensOf(runState);
  if (used === undefined) return null;
  return { sessionUpdate: "usage_update", used, size: contextWindowFor(modelId) };
}
