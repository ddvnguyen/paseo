/**
 * Injects a provider's context ceiling into OpenCode's own configuration.
 *
 * OpenCode merges the `provider.<id>.models.<model>.limit` fragment from
 * configuration over the models.dev catalog entry, and reads the compaction
 * threshold off its resolved `Model` — which is the surface this module writes.
 *
 * `limit` is a closed object, not a partial one: OpenCode's config schema declares
 * it as `{ context: number; output: number }` and rejects the *entire*
 * configuration when either key is absent, which takes down every spawn and every
 * snapshot refresh rather than just the capped model. So both keys are always
 * written together. `output` is OpenCode's own value from the runtime catalog, so
 * the merged model keeps the output ceiling it would have had uncapped; a value
 * the config already carries is preserved rather than clobbered.
 *
 * Capping `context` alone does not enforce anything. OpenCode's `usable()` in
 * `packages/opencode/src/session/overflow.ts` returns `limit.input - reserved`
 * whenever `limit.input` is set and only falls back to `limit.context` when it is
 * not, so on every model whose catalog entry carries an `input` the catalog window
 * — not the cap — decides when compaction fires. `input` is therefore capped to the
 * same ceiling, and left absent for models that declare none, because inventing one
 * would change how a model that already works is treated.
 *
 * `reserved` is OpenCode's own (`compaction.reserved`, defaulting to the lesser of
 * 20k and the model's max output), so the resulting threshold is the ceiling minus
 * that reserve. That gap between the meter and the compaction point is OpenCode's
 * native behaviour: an uncapped model compacts at `input - reserved` too, just at a
 * larger number.
 *
 * Everything here is pure: the input config is never mutated, and applying the
 * same caps twice produces the same object, so `decorateServerEnv` stays safe to
 * run on every server spawn.
 */

interface OpenCodeModelLimit {
  context?: number;
  output?: number;
  input?: number;
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
  /**
   * The model's own `limit.input`. OpenCode's compaction threshold reads this in
   * preference to `limit.context`, so a model whose catalog entry has one needs it
   * capped too or the cap never fires. Left undefined for models that declare none.
   */
  inputLimit?: number;
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

/**
 * The lower of the numbers that are actually known, never above `ceiling`.
 * Undefined when nothing is known, so a cap never introduces a limit the model
 * does not already have and a lower existing value is never erased.
 */
function readLower(
  left: number | undefined,
  right: number | undefined,
  ceiling: number,
): number | undefined {
  const known = [left, right].filter(isPositiveFiniteNumber);
  return known.length === 0 ? undefined : Math.min(ceiling, ...known);
}

/** Stable identity for a capped model, matching the agent's own lookup-key format. */
export function openCodeContextCapKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

/**
 * A short, order-independent fingerprint of the cap set. The server manager stores
 * this on the generation it spawned so a later generation is requested when the
 * desired caps change — without that, a cap learned after the first spawn would sit
 * inert until something else happened to restart OpenCode. `outputLimit` and
 * `inputLimit` are part of the fingerprint because they decide whether a model is
 * cappable at all and where its threshold lands, so a model that gains either one
 * needs a new generation.
 */
export function openCodeContextCapsKey(caps: Iterable<OpenCodeModelContextCap>): string {
  return [...caps]
    .filter(
      (cap) =>
        cap.providerId.trim().length > 0 &&
        cap.modelId.trim().length > 0 &&
        isPositiveFiniteNumber(cap.contextCap),
    )
    .map((cap) => {
      const residuals = `${cap.outputLimit ?? ""}/${cap.inputLimit ?? ""}`;
      return `${openCodeContextCapKey(cap.providerId, cap.modelId)}=${cap.contextCap}/${residuals}`;
    })
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

    // `input` is capped only when there is one to cap, and never above the window
    // itself. A model that declares none keeps resolving its threshold from
    // `context`, which is already capped above, so nothing is written for it.
    const existingInput = readPositiveNumber(limit.input);
    const nextInput = readLower(existingInput, readPositiveNumber(cap.inputLimit), nextContext);

    if (
      modelConfig.limit !== undefined &&
      existing === nextContext &&
      existingOutput === nextOutput &&
      (nextInput === undefined || nextInput === limit.input)
    ) {
      continue;
    }

    limit.context = nextContext;
    limit.output = nextOutput;
    if (nextInput !== undefined) {
      limit.input = nextInput;
    }
    models[modelId] = { ...modelConfig, limit };
    provider[providerId] = { ...providerConfig, models };
    changed = true;
  }

  return changed ? { ...config, provider } : config;
}
