import type { ModelInfo, SessionModelState } from "@agentclientprotocol/sdk";

import { DEFAULT_FREEBUFF_MODEL, FREEBUFF_AGENT_ID_BY_MODEL } from "./freebuff-agent.js";

/** Human-readable names for the free-tier catalog (falls back to the raw id). */
const MODEL_DISPLAY_NAMES: Record<string, string> = {
  "deepseek/deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
  "mimo/mimo-v2.5": "MiMo V2.5",
  "mimo/mimo-v2.6-pro": "MiMo V2.6 Pro",
  "minimax/minimax-m3": "MiniMax M3",
  "openai/gpt-5.6-luna": "GPT-5.6 Luna",
  "z-ai/glm-5.2": "GLM 5.2",
  "z-ai/glm-5.3-flash": "GLM 5.3 Flash",
  "upstage/solar-pro4": "Solar Pro 4",
  "google/gemini-3.8-flash": "Gemini 3.8 Flash",
  "meta/muse-spark-1.3-contributor": "Muse Spark 1.3 Contributor",
};

export const FREEBUFF_MODELS: ModelInfo[] = Object.keys(FREEBUFF_AGENT_ID_BY_MODEL).map(
  (modelId) => ({
    modelId,
    name: MODEL_DISPLAY_NAMES[modelId] ?? modelId,
    description: "Freebuff free-tier model",
  }),
);

export const FREEBUFF_MODEL_IDS: ReadonlySet<string> = new Set(
  FREEBUFF_MODELS.map((model) => model.modelId),
);

/**
 * The model a fresh session starts on: FREEBUFF_MODEL (passed through even
 * when it is newer than the bundled catalog), else the default.
 */
export function initialModelId(env: NodeJS.ProcessEnv): string {
  return env.FREEBUFF_MODEL?.trim() || DEFAULT_FREEBUFF_MODEL;
}

export function modelState(currentModelId: string): SessionModelState {
  return {
    availableModels: FREEBUFF_MODELS,
    currentModelId: FREEBUFF_MODEL_IDS.has(currentModelId) ? currentModelId : DEFAULT_FREEBUFF_MODEL,
  };
}
