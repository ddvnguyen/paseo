import type { ModelInfo, SessionModelState } from "@agentclientprotocol/sdk";

import { credentialsForAccount, findAccount } from "./accounts.js";
import type { AccountStatus } from "./account.js";
import { fetchAccountStatus } from "./account.js";
import { readDisabledModels } from "./disabled-models.js";
import { DEFAULT_FREEBUFF_MODEL, FREEBUFF_AGENT_ID_BY_MODEL } from "./freebuff-agent.js";

/**
 * Display names and taglines as the Freebuff CLI shows them (mirrors the CLI's
 * model catalog). Prices are NOT hardcoded: the server's session probe is the
 * source of truth and changes with peak/off-peak, so they are merged in at
 * runtime (see `modelState`).
 */
const MODEL_CATALOG: Record<string, { name: string; tagline: string }> = {
  "deepseek/deepseek-v4-pro": { name: "DeepSeek V4 Pro", tagline: "Deep reasoning" },
  "deepseek/deepseek-v4-flash": { name: "DeepSeek V4.1 Flash", tagline: "Smart & Fast" },
  "mimo/mimo-v2.5": { name: "MiMo 2.6 Flash", tagline: "Balanced" },
  "mimo/mimo-v2.6-pro": { name: "MiMo 2.6 Pro", tagline: "Strong reasoning" },
  "minimax/minimax-m3": { name: "MiniMax M3", tagline: "Fastest" },
  "openai/gpt-5.6-luna": { name: "GPT-5.6 Luna", tagline: "Strong all-around" },
  "openai/gpt-6-luna": { name: "GPT-6 Luna", tagline: "Strong all-around" },
  "z-ai/glm-5.2": { name: "GLM 5.2", tagline: "Unlock by referring friends" },
  "z-ai/glm-5.3-flash": { name: "GLM 5.3 Flash", tagline: "Deep reasoning" },
  "upstage/solar-pro4": { name: "Solar Pro 4", tagline: "Limited-time trial" },
  "upstage/solar-mini4": { name: "Solar Mini 4", tagline: "Fast and light" },
  "google/gemini-3.8-flash": { name: "Gemini 3.8 Flash", tagline: "1M context" },
  "meta/muse-spark-1.3-contributor": { name: "Muse Spark 1.3", tagline: "Queues, then falls back" },
  "meta/muse-spark-1.2-contributor": { name: "Muse Spark 1.2", tagline: "Queue" },
  "stealth/ox-alpha": { name: "Ox Alpha", tagline: "1M context (stealth)" },
  "stealth/space-bunny-alpha": { name: "Space Bunny Alpha", tagline: "1M context (stealth)" },
};

function describeModel(modelId: string, status: AccountStatus | null): string {
  const tagline = MODEL_CATALOG[modelId]?.tagline ?? "Freebuff free-tier model";
  const price = status?.prices[modelId];
  if (price === undefined) return tagline;
  const cost = price === 0 ? "Free" : `${price} Freebucks/hour`;
  const notice = status?.priceNotices[modelId];
  return `${tagline} · ${cost}${notice ? ` (${notice})` : ""}`;
}

function catalogModels(status: AccountStatus | null): ModelInfo[] {
  return Object.keys(FREEBUFF_AGENT_ID_BY_MODEL).map((modelId) => ({
    modelId,
    name: MODEL_CATALOG[modelId]?.name ?? modelId,
    description: describeModel(modelId, status),
  }));
}

export const FREEBUFF_MODELS: ModelInfo[] = catalogModels(null);

export const FREEBUFF_MODEL_IDS: ReadonlySet<string> = new Set(
  FREEBUFF_MODELS.map((model) => model.modelId),
);

/**
 * One catalog row for the `models list` surface: display info, the
 * probe-sourced open-session price (undefined when the probe is unreachable —
 * prices are never hardcoded), and whether the host may still offer it.
 */
export interface ModelRow {
  id: string;
  name: string;
  tagline: string;
  /** Cost to open a session, from the status probe; undefined when unknown. */
  priceFreebucks?: number;
  /** How long a fresh seat lasts (FREEBUFF_SEAT_LIFETIME_MS default in turn.ts). */
  sessionLengthMs: number;
  /** Server note on this model's price (peak/off-peak, trials); undefined when none. */
  priceNotice?: string;
  enabled: boolean;
}

/** Fresh-seat lifetime a reported price buys, in milliseconds. */
export const MODEL_SESSION_LENGTH_MS = 3_600_000;

/** Every catalog model with its price (when known) and enabled flag. */
export function listModels(
  env: NodeJS.ProcessEnv = process.env,
  status: AccountStatus | null = null,
): ModelRow[] {
  const disabled = new Set(readDisabledModels(env));
  return Object.keys(FREEBUFF_AGENT_ID_BY_MODEL).map((modelId) => {
    const row: ModelRow = {
      id: modelId,
      name: MODEL_CATALOG[modelId]?.name ?? modelId,
      tagline: MODEL_CATALOG[modelId]?.tagline ?? "Freebuff free-tier model",
      sessionLengthMs: MODEL_SESSION_LENGTH_MS,
      enabled: !disabled.has(modelId),
    };
    const price = status?.prices[modelId];
    if (price !== undefined) row.priceFreebucks = price;
    const notice = status?.priceNotices[modelId];
    if (notice !== undefined) row.priceNotice = notice;
    return row;
  });
}

/**
 * Catalog rows with prices from the default account's status probe. Rows are
 * still listed (priceless) when no account can reach the server.
 */
export async function listModelsWithPrices(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelRow[]> {
  const account = findAccount(undefined, env);
  const token = account ? credentialsForAccount(account, env)?.apiKey : undefined;
  const status = token ? await fetchAccountStatus(token) : null;
  return listModels(env, status);
}

/**
 * The model a fresh session starts on: FREEBUFF_MODEL (passed through even
 * when it is newer than the bundled catalog), else the default.
 */
export function initialModelId(env: NodeJS.ProcessEnv): string {
  return env.FREEBUFF_MODEL?.trim() || DEFAULT_FREEBUFF_MODEL;
}

export function modelState(
  currentModelId: string,
  status: AccountStatus | null = null,
  env: NodeJS.ProcessEnv = process.env,
): SessionModelState {
  const disabled = new Set(readDisabledModels(env));
  return {
    availableModels: catalogModels(status).filter((model) => !disabled.has(model.modelId)),
    currentModelId: FREEBUFF_MODEL_IDS.has(currentModelId)
      ? currentModelId
      : DEFAULT_FREEBUFF_MODEL,
  };
}

/**
 * Reject a model for NEW selection: unknown ids and disabled models. Running
 * sessions keep their model — this only gates newSession/setSessionModel.
 */
export function assertModelSelectable(modelId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!FREEBUFF_MODEL_IDS.has(modelId)) throw new Error(`Unknown model: ${modelId}`);
  if (readDisabledModels(env).includes(modelId)) {
    throw new Error(
      `Model "${modelId}" is disabled (re-enable it with: models set-enabled --id "${modelId}" --enabled true).`,
    );
  }
}
