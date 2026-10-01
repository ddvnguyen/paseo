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

export type ProviderModelPrefixes = ReadonlyMap<string, string>;

/**
 * Reads `modelPrefix` out of the daemon's provider overrides. The config file is
 * the single place a prefix is declared, so every picker derives it from here
 * instead of the model catalog — a catalog carries no notion of "which config
 * entry produced this row".
 */
export function buildProviderModelPrefixes(
  config: MutableDaemonConfig | null | undefined,
): ProviderModelPrefixes {
  const prefixes = new Map<string, string>();
  for (const [providerId, override] of Object.entries(config?.providers ?? {})) {
    const prefix = normalizeProviderModelPrefix(override.modelPrefix);
    if (prefix) {
      prefixes.set(providerId, prefix);
    }
  }
  return prefixes;
}
