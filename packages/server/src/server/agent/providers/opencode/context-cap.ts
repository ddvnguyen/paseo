/**
 * Injects a provider's context ceiling into OpenCode's own configuration.
 *
 * OpenCode compacts a session on its own once the conversation reaches a model's
 * `limit.context`, so lowering that number is what actually enforces a Paseo-side
 * cap. OpenCode reads `limit.context` from its resolved `Model`, and merges the
 * `provider.<id>.models.<model>.limit` fragment from configuration over the
 * models.dev catalog entry — which is the surface this module writes.
 *
 * Everything here is pure: the input config is never mutated, and applying the
 * same caps twice produces the same object, so `decorateServerEnv` stays safe to
 * run on every server spawn.
 */

interface OpenCodeModelLimit {
  context?: number;
  output?: number;
  [key: string]: unknown;
}

interface OpenCodeModelConfig {
  limit?: OpenCodeModelLimit;
  [key: string]: unknown;
}

interface OpenCodeProviderConfig {
  models?: Record<string, OpenCodeModelConfig>;
  [key: string]: unknown;
}

export interface OpenCodeContextCapConfig {
  provider?: Record<string, OpenCodeProviderConfig>;
  [key: string]: unknown;
}

export interface OpenCodeModelContextCap {
  /** OpenCode sub-provider id, e.g. `anthropic` or a custom gateway host. */
  providerId: string;
  /** Model id as OpenCode knows it, i.e. the part after `<providerId>/`. */
  modelId: string;
  contextCap: number;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function readExistingContext(limit: OpenCodeModelLimit | undefined): number | undefined {
  const context = limit?.context;
  return isPositiveFiniteNumber(context) ? context : undefined;
}

/** Stable identity for a capped model, matching the agent's own lookup-key format. */
export function openCodeContextCapKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/**
 * A short, order-independent fingerprint of the cap set. The server manager stores
 * this on the generation it spawned so a later generation is requested when the
 * desired caps change — without that, a cap learned after the first spawn would sit
 * inert until something else happened to restart OpenCode.
 */
export function openCodeContextCapsKey(caps: Iterable<OpenCodeModelContextCap>): string {
  return [...caps]
    .filter(
      (cap) =>
        cap.providerId.trim().length > 0 &&
        cap.modelId.trim().length > 0 &&
        isPositiveFiniteNumber(cap.contextCap),
    )
    .map((cap) => `${openCodeContextCapKey(cap.providerId, cap.modelId)}=${cap.contextCap}`)
    .sort()
    .join(",");
}

/**
 * Returns a config whose capped models carry `limit.context` at the lower of the
 * ceiling and whatever the config already asked for. An existing lower value is
 * left alone: a cap may only lower a window, never raise one.
 */
export function applyOpenCodeContextCaps(
  config: OpenCodeContextCapConfig,
  caps: Iterable<OpenCodeModelContextCap>,
): OpenCodeContextCapConfig {
  const provider = { ...config.provider };
  let changed = false;

  for (const cap of caps) {
    const { providerId, modelId, contextCap } = cap;
    if (
      providerId.trim().length === 0 ||
      modelId.trim().length === 0 ||
      !isPositiveFiniteNumber(contextCap)
    ) {
      continue;
    }

    const providerConfig = provider[providerId] ?? {};
    const models = { ...providerConfig.models };
    const modelConfig = models[modelId] ?? {};
    const limit = { ...modelConfig.limit };

    const existing = readExistingContext(limit);
    const nextContext = existing === undefined ? contextCap : Math.min(existing, contextCap);
    if (existing === nextContext && modelConfig.limit !== undefined) {
      continue;
    }

    limit.context = nextContext;
    models[modelId] = { ...modelConfig, limit };
    provider[providerId] = { ...providerConfig, models };
    changed = true;
  }

  return changed ? { ...config, provider } : config;
}
