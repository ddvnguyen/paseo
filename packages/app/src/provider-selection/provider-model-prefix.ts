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
 * One rendered block of the provider sheet: a sub-provider's tag field together
 * with the models that belong under it.
 */
export interface SubProviderModelSection<T> {
  /**
   * `undefined` marks the remainder section: served models that declare no
   * sub-provider. They have no tag field to sit under, so the sheet gives them a
   * plain header of their own.
   */
  subProviderId: string | undefined;
  models: T[];
}

/** The shape `readModelSubProviderId` needs; named so the section builder reads as one contract. */
interface ModelWithSubProvider {
  id: string;
  metadata?: Record<string, unknown>;
}

/**
 * Pairs the tag fields with the rows they sit above.
 *
 * Two inputs, deliberately different ones. `subProviderIds` comes from the
 * UNFILTERED served models, because a search box must not make a configured tag
 * unreachable — a field that vanishes while you type is a field you cannot edit.
 * `filteredModels` supplies the rows, so a search narrows what is listed without
 * narrowing what is configurable.
 *
 * The union is what makes this safe to render: a sub-provider that only the
 * filtered rows mention still gets a section. Grouping the rows without this
 * would leave them in a bucket with no header above it, which is the one failure
 * mode a grouping pass can have.
 */
export function buildSubProviderModelSections<T extends ModelWithSubProvider>(
  subProviderIds: readonly string[],
  filteredModels: readonly T[],
): SubProviderModelSection<T>[] {
  const rowsBySubProvider = new Map<string, T[]>();
  const remainder: T[] = [];

  for (const model of filteredModels) {
    // The same accessor collectSubProviderIds uses. Any other key derivation can
    // disagree with the section list, and a disagreement strands rows.
    const subProviderId = readModelSubProviderId(model);
    if (subProviderId === undefined) {
      remainder.push(model);
      continue;
    }
    const bucket = rowsBySubProvider.get(subProviderId);
    if (bucket) {
      bucket.push(model);
    } else {
      rowsBySubProvider.set(subProviderId, [model]);
    }
  }

  const sections: SubProviderModelSection<T>[] = [];
  for (const subProviderId of subProviderIds) {
    sections.push({ subProviderId, models: rowsBySubProvider.get(subProviderId) ?? [] });
  }

  // Sorted like collectSubProviderIds so a sub that only the filtered rows
  // mention cannot reorder the sections above it.
  const unplaced = [...rowsBySubProvider.keys()]
    .filter((subProviderId) => !subProviderIds.includes(subProviderId))
    .sort((a, b) => a.localeCompare(b));
  for (const subProviderId of unplaced) {
    sections.push({ subProviderId, models: rowsBySubProvider.get(subProviderId) ?? [] });
  }

  // Omitted when empty: a provider whose every served model declares a
  // sub-provider has no leftover group, and an empty one would read as a section
  // that failed to load.
  if (remainder.length > 0) {
    sections.push({ subProviderId: undefined, models: remainder });
  }

  return sections;
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
