/**
 * Validation, dirty-tracking, and wire encoding for a provider's `modelPrefix`
 * model tag.
 *
 * Config stores a short string; users type it with or without the brackets the
 * renderer adds. Nothing here touches React or the daemon — the settings sheet
 * renders these results and dispatches the save, the same split the
 * max-context field uses.
 */

import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { normalizeProviderModelPrefix } from "@/provider-selection/provider-model-prefix";

// Mirrors the wire cap (`modelPrefix: z.string().max(24)` on the patch entry).
// The trimmed text is checked rather than the normalized token so brackets
// count too: normalization only removes characters, so a trimmed text within
// the cap always stores within the cap.
const MODEL_PREFIX_MAX_LENGTH = 24;

/**
 * The provider patch that writes — or removes — a tag.
 *
 * A cleared tag is an explicit `null`, never an absent key. The config patch is
 * merge-only, so `{ provider: {} }` cannot unset a scalar: it merges to a
 * no-op and the old tag survives the patch, the persisted file, and every
 * reload. The daemon deletes the key when it sees the marker.
 */
export function buildProviderModelPrefixPatch(
  provider: string,
  prefix: string | undefined,
): NonNullable<MutableDaemonConfigPatch["providers"]> {
  return { [provider]: { modelPrefix: prefix ?? null } };
}

/**
 * The provider patch that writes — or removes — one sub-provider's tag.
 *
 * The same explicit-`null` rule as the provider-wide tag, applied per key: the
 * map is merge-only too, so an absent key would leave the old tag in place and
 * an empty map would be ambiguous with "leave the whole map alone". The daemon
 * drops the marked key and keeps its siblings.
 */
export function buildProviderSubModelPrefixPatch(
  provider: string,
  subProviderId: string,
  prefix: string | undefined,
): NonNullable<MutableDaemonConfigPatch["providers"]> {
  return { [provider]: { modelPrefixes: { [subProviderId]: prefix ?? null } } };
}

export interface ModelPrefixFieldState {
  /** True when saving would change the stored value. */
  isDirty: boolean;
  /** False only for text longer than the wire cap allows. */
  isValid: boolean;
  /** The value to persist; absent means "no tag" (delete the key). */
  normalized: string | undefined;
  /** Why the text is invalid, or null while it can be saved. */
  invalidReason: "too-long" | null;
}

/**
 * One derivation of the field's render state so the sheet cannot disagree with
 * itself about whether the typed text is saveable.
 *
 * Dirty compares normalized forms, so retyping `Go` over a stored `[Go]` (or
 * vice versa) is not a change — both render as `[Go]`.
 */
export function resolveModelPrefixFieldState(
  text: string,
  storedPrefix: string | undefined,
): ModelPrefixFieldState {
  const trimmed = text.trim();
  if (trimmed.length > MODEL_PREFIX_MAX_LENGTH) {
    return { normalized: undefined, isValid: false, isDirty: false, invalidReason: "too-long" };
  }

  const normalized = normalizeProviderModelPrefix(trimmed);
  return {
    normalized,
    isValid: true,
    isDirty: normalized !== normalizeProviderModelPrefix(storedPrefix),
    invalidReason: null,
  };
}
