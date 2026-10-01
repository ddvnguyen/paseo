import type { AgentModelDefinition } from "./agent-sdk-types.js";

interface ModelLimit {
  context?: number;
}

interface MetadataWithLimit {
  limit?: ModelLimit;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function capWindow(reported: number | undefined, cap: number): number {
  return reported === undefined ? cap : Math.min(reported, cap);
}

function capLimit(limit: ModelLimit, cap: number): ModelLimit {
  return { ...limit, context: capWindow(limit.context, cap) };
}

function capMetadataLimit(
  metadata: AgentModelDefinition["metadata"],
  cap: number,
): AgentModelDefinition["metadata"] {
  const limit = (metadata as MetadataWithLimit | undefined)?.limit;
  if (typeof limit !== "object" || limit === null) {
    return metadata;
  }
  return { ...metadata, limit: capLimit(limit, cap) };
}

/**
 * The single place a provider's `maxContextTokens` ceiling is enforced.
 *
 * Every model the registry hands out — runtime-discovered, `models`,
 * `additionalModels`, or plugin-registered — passes through here, so pickers,
 * agent headers, and context meters all read the same capped number. Adapters
 * keep reporting whatever their upstream catalog claims; this is the only
 * correction point, which is what makes the ceiling one source of truth instead
 * of a per-adapter convention.
 *
 * `contextWindowMaxTokens` is the field the wire and the app read. OpenCode's
 * own `metadata.limit.context` is corrected alongside it because that is the
 * shape OpenCode clients and plugins query directly.
 */
export function applyProviderContextCap(
  model: AgentModelDefinition,
  cap: number | undefined,
): AgentModelDefinition {
  if (cap === undefined) {
    return model;
  }

  return {
    ...model,
    contextWindowMaxTokens: capWindow(readPositiveNumber(model.contextWindowMaxTokens), cap),
    metadata: capMetadataLimit(model.metadata, cap),
  };
}
