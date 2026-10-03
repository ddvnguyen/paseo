import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

const SURROUNDING_BRACKETS = /^\[(.*)\]$/;

/**
 * Normalizes a configured `modelPrefix` into the bare token the renderer
 * brackets. Users type either `Go` or `[Go]`; both render as `[Go]`. Empty and
 * whitespace-only values mean "no tag", which is what keeps an untouched
 * provider's labels undecorated.
 */
export function normalizeProviderModelPrefix(prefix: string | undefined): string | undefined {
  const trimmed = prefix?.trim();
  if (!trimmed) {
    return undefined;
  }
  const bracketed = trimmed.match(SURROUNDING_BRACKETS);
  if (!bracketed) {
    return trimmed;
  }
  return bracketed[1]?.trim() || undefined;
}

export function formatProviderModelPrefix(prefix: string | undefined): string {
  return prefix ? `[${prefix}]` : "";
}

/**
 * The tags one provider declares: a provider-wide fallback plus an optional tag
 * per upstream sub-provider.
 *
 * An aggregating provider (OpenCode serves `anthropic`, `openai`,
 * `github-copilot`, ... under one `opencode` id) cannot be decorated with a
 * single string, so the per-sub map is what makes those rows distinguishable.
 * `providerWide` stays because it is the fallback for rows with no per-sub
 * entry AND the only tag every config written before `modelPrefixes` had.
 */
export interface ProviderModelPrefixTags {
  providerWide: string | undefined;
  bySubProvider: ReadonlyMap<string, string>;
}

export type ProviderModelPrefixes = ReadonlyMap<string, ProviderModelPrefixTags>;

/**
 * Reads the model tags out of the daemon's provider overrides. The config file
 * is the single place a prefix is declared, so every picker derives it from here
 * instead of the model catalog — a catalog carries no notion of "which config
 * entry produced this row".
 */
export function buildProviderModelPrefixes(
  config: MutableDaemonConfig | null | undefined,
): ProviderModelPrefixes {
  const prefixes = new Map<string, ProviderModelPrefixTags>();
  for (const [providerId, override] of Object.entries(config?.providers ?? {})) {
    const providerWide = normalizeProviderModelPrefix(override.modelPrefix);
    const bySubProvider = new Map<string, string>();
    for (const [subProviderId, prefix] of Object.entries(override.modelPrefixes ?? {})) {
      const normalized = normalizeProviderModelPrefix(prefix);
      if (normalized) {
        bySubProvider.set(subProviderId, normalized);
      }
    }
    if (providerWide || bySubProvider.size > 0) {
      prefixes.set(providerId, { providerWide, bySubProvider });
    }
  }
  return prefixes;
}

/**
 * The sub-provider a model belongs to, or undefined when it declares none.
 *
 * Read from `metadata.providerId`, which an adapter sets when it serves several
 * upstream catalogs under one Paseo provider id. Deliberately NOT derived from
 * the model's id: a leading path segment is not a sub-provider id in general, and
 * guessing one would silently tag a model with another sub-provider's tag. An
 * absent or non-string value simply means "no sub-provider", which routes the row
 * to the provider-wide fallback.
 */
export function readModelSubProviderId(model: {
  id: string;
  metadata?: Record<string, unknown>;
}): string | undefined {
  const subProviderId = model.metadata?.providerId;
  if (typeof subProviderId !== "string") {
    return undefined;
  }
  const trimmed = subProviderId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The distinct sub-providers a provider's models declare, sorted.
 *
 * This is what decides how many tag sections the settings sheet renders. Derived
 * from the models the daemon actually serves rather than a static list, so the
 * sections follow the user's credentials instead of a hand-maintained roster.
 */
export function collectSubProviderIds(
  models: readonly { id: string; metadata?: Record<string, unknown> }[],
): string[] {
  const ids = new Set<string>();
  for (const model of models) {
    const subProviderId = readModelSubProviderId(model);
    if (subProviderId) {
      ids.add(subProviderId);
    }
  }
  // Sorted so the sections keep a stable order across refreshes.
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * The tag one model row renders: its own sub-provider's tag when it declares
 * one, otherwise the provider-wide tag. A provider with no tags at all resolves
 * to undefined, which leaves the label undecorated.
 */
export function resolveModelPrefixTags(
  tags: ProviderModelPrefixTags | undefined,
  model: { id: string; metadata?: Record<string, unknown> },
): string | undefined {
  if (!tags) {
    return undefined;
  }
  const subProviderId = readModelSubProviderId(model);
  const perSubProvider = subProviderId ? tags.bySubProvider.get(subProviderId) : undefined;
  return perSubProvider ?? tags.providerWide;
}
