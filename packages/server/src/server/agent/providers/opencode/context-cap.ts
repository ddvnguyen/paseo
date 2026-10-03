/**
 * Injects a provider's context ceiling into OpenCode's own configuration.
 *
 * OpenCode compacts a session on its own once the conversation reaches a model's
 * `limit.context`, so lowering that number is what actually enforces a Paseo-side
 * cap. OpenCode reads `limit.context` from its resolved `Model`, and merges the
 * `provider.<id>.models.<model>.limit` fragment from configuration over the
 * models.dev catalog entry — which is the surface this module writes.
 *
 * `limit` is a closed object, not a partial one: OpenCode's config schema declares
 * it as `{ context: number; output: number }` and rejects the *entire*
 * configuration when either key is absent, which takes down every spawn and every
 * snapshot refresh rather than just the capped model. So both keys are always
 * written together. `output` is OpenCode's own value from the runtime catalog, so
 * the merged model keeps the output ceiling it would have had uncapped; a value
 * the config already carries is preserved rather than clobbered.
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
  /**
   * The model's own output ceiling, read from OpenCode's runtime catalog.
   * Required in practice: without it the `limit` object cannot be written in a
   * form OpenCode accepts, and a model whose catalog entry carries no output
   * limit is therefore left uncapped rather than capping every model at once.
   */
  outputLimit?: number;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function readExistingContext(limit: OpenCodeModelLimit | undefined): number | undefined {
  const context = limit?.context;
  return isPositiveFiniteNumber(context) ? context : undefined;
}

function readExistingOutput(limit: OpenCodeModelLimit | undefined): number | undefined {
  const output = limit?.output;
  return isPositiveFiniteNumber(output) ? output : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return isPositiveFiniteNumber(value) ? value : undefined;
}

/** Stable identity for a capped model, matching the agent's own lookup-key format. */
export function openCodeContextCapKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/**
 * A short, order-independent fingerprint of the cap set. The server manager stores
 * this on the generation it spawned so a later generation is requested when the
 * desired caps change — without that, a cap learned after the first spawn would sit
 * inert until something else happened to restart OpenCode. `outputLimit` is part of
 * the fingerprint because a model that gains one becomes cappable at all.
 */
export function openCodeContextCapsKey(caps: Iterable<OpenCodeModelContextCap>): string {
  return [...caps]
    .filter(
      (cap) =>
        cap.providerId.trim().length > 0 &&
        cap.modelId.trim().length > 0 &&
        isPositiveFiniteNumber(cap.contextCap),
    )
    .map(
      (cap) =>
        `${openCodeContextCapKey(cap.providerId, cap.modelId)}=${cap.contextCap}/${cap.outputLimit ?? ""}`,
    )
    .sort()
    .join(",");
}

/**
 * Returns a config whose capped models carry a complete `limit` at the lower of the
 * ceiling and whatever the config already asked for. An existing lower value is
 * left alone: a cap may only lower a window, never raise one.
 *
 * A model with no usable output limit on either side is skipped, because the only
 * way to satisfy OpenCode's schema without one would be to invent it.
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
    // The config's own output ceiling wins, so a user who set one keeps it.
    const existingOutput = readExistingOutput(limit);
    const nextOutput = existingOutput ?? readPositiveNumber(cap.outputLimit);
    if (nextOutput === undefined) {
      continue;
    }

    const nextContext = existing === undefined ? contextCap : Math.min(existing, contextCap);
    if (
      modelConfig.limit !== undefined &&
      existing === nextContext &&
      existingOutput === nextOutput
    ) {
      continue;
    }

    limit.context = nextContext;
    limit.output = nextOutput;
    models[modelId] = { ...modelConfig, limit };
    provider[providerId] = { ...providerConfig, models };
    changed = true;
  }

  return changed ? { ...config, provider } : config;
}
