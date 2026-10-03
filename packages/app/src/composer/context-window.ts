/**
 * Where the composer decides what context ceiling its meter draws.
 *
 * Two numbers can claim to be the window. The agent's `lastUsage` carries the
 * number its harness reported, and the daemon config carries the ceiling the
 * user set for the provider. They are written by different processes and never
 * cross-checked, so the meter has to reconcile them here — it takes the lower
 * of the two for the ceiling, and for the usage. A cap that raised the ceiling
 * would claim headroom the harness never agreed to, and usage past the ceiling
 * draws as a full meter. A meter pinned at 100% is the visible proof the cap
 * is real.
 */

import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

export interface ContextWindowValues {
  contextWindowMaxTokens: number | null;
  contextWindowUsedTokens: number | null;
}

/**
 * The configured ceiling for one provider, or null when the provider declares
 * none worth enforcing.
 *
 * Keyed by the Paseo provider id, the same key the settings sheet writes and
 * reads. A non-finite or non-positive cap is treated as no cap at all: the
 * config schema rejects those on the way in, but a hand-edited file or an older
 * daemon must not be able to divide the meter by zero.
 */
export function resolveConfiguredContextCap(
  config: MutableDaemonConfig | null | undefined,
  provider: string | null,
): number | null {
  if (!provider) {
    return null;
  }
  const cap = config?.providers?.[provider]?.maxContextTokens;
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) {
    return null;
  }
  return cap;
}

/**
 * The pair the meter renders, both halves held to the configured cap whenever
 * the provider has one.
 *
 * `min`, never `max`: a cap is a ceiling the user imposed, so it can lower a
 * harness-reported window but never inflate one. With no cap this returns the
 * runtime pair verbatim, so only a cap can pin the meter.
 *
 * Usage above the displayed maximum resolves to the displayed maximum. That
 * keeps the percentage at or under 100% and stops the ring and the label
 * disagreeing about how full the window is: a harness reporting more than the
 * user's ceiling has already crossed it.
 *
 * An unknown runtime value stays unknown. Both halves of the pair are nulled
 * together because a percentage needs both, and a maximum on its own would draw
 * a meter against a usage count nobody has reported.
 */
export function resolveContextWindowValues(
  rawMax: number | null,
  rawUsed: number | null,
  configuredCap: number | null = null,
): ContextWindowValues {
  if (typeof rawMax !== "number" || typeof rawUsed !== "number") {
    return { contextWindowMaxTokens: null, contextWindowUsedTokens: null };
  }
  const cap =
    typeof configuredCap === "number" && Number.isFinite(configuredCap) && configuredCap > 0
      ? configuredCap
      : null;
  // No cap means no reconciliation: hand back the runtime pair exactly as it
  // arrived, over-100% usage included. The meter clamps its own ring sweep.
  if (cap === null) {
    return { contextWindowMaxTokens: rawMax, contextWindowUsedTokens: rawUsed };
  }
  const displayMax = Math.min(rawMax, cap);
  // A maximum nobody can divide by leaves the usage count alone; clamping
  // against it would manufacture a NaN the meter already reads as unknown.
  const displayUsed = displayMax > 0 ? Math.min(rawUsed, displayMax) : rawUsed;
  return {
    contextWindowMaxTokens: displayMax,
    contextWindowUsedTokens: displayUsed,
  };
}
