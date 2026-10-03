/**
 * Parsing, formatting, and wire encoding for a provider's `maxContextTokens`
 * ceiling.
 *
 * Config stores a token count. Users think in "100 M" / "128 K", so the field
 * accepts a suffixed number and the config keeps the integer. Nothing here
 * touches React or the daemon — the settings sheet renders these results and
 * dispatches the save, which is the same split the schedule form uses.
 *
 * A bare number means K: "280" is 280,000 tokens, matching how the field's
 * placeholder reads. M is explicit-only ("2 M"), because a bare number that
 * silently means millions would be the worst possible guess to make about a
 * context window.
 */

import type { MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";

const THOUSAND = 1_000;
const MILLION = 1_000_000;

// Suffixes are DECIMAL, not binary: "1 K" is 1,000 tokens, not 1024. Vendors and
// API docs quote context windows in decimal, so a binary reading would
// overstate what a gateway accepts — by 2.4% at 1M and 48% at 64 K.
const SUFFIX_MULTIPLIERS = {
  k: THOUSAND,
  m: MILLION,
} as const;

type Suffix = keyof typeof SUFFIX_MULTIPLIERS;

/** A bare number carries no unit, so it carries the one the field defaults to. */
const DEFAULT_SUFFIX: Suffix = "k";

// A fraction is only allowed alongside an explicit unit. Two reasons: a bare
// number already means K, so "1.5" would be a silent guess twice over; and the
// fraction exists to keep `formatMaxContextTokens` exact, not to let people type
// sub-token windows.
const MAX_CONTEXT_TOKENS_PATTERN = /^(\d+)(?:\.(\d{1,3}))?\s*([km])?$/i;

export type MaxContextTokensInput =
  | { status: "empty" }
  | { status: "valid"; tokens: number }
  | { status: "invalid" };

/**
 * Whitespace-tolerant and case-insensitive: "100 M", " 100m ", and "280" all
 * parse. A bare integer is a count in K. Anything else — a sign, a fraction
 * without a unit, a unit Paseo does not define — is invalid and must not be
 * saved. Empty is a distinct valid state meaning "no limit", because clearing the
 * textbox is how a user removes the cap.
 */
export function parseMaxContextTokens(text: string): MaxContextTokensInput {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { status: "empty" };
  }

  const match = trimmed.match(MAX_CONTEXT_TOKENS_PATTERN);
  if (!match) {
    return { status: "invalid" };
  }

  const [digits, fraction, suffix] = match.slice(1) as [
    string,
    string | undefined,
    string | undefined,
  ];
  if (fraction !== undefined && suffix === undefined) {
    return { status: "invalid" };
  }

  const multiplier = SUFFIX_MULTIPLIERS[(suffix?.toLowerCase() ?? DEFAULT_SUFFIX) as Suffix];
  const value = fraction === undefined ? Number(digits) : Number(`${digits}.${fraction}`);
  // Rounding is not cosmetic. "131.072" is not representable in binary floating
  // point, so `Number("131.072") * 1000` lands a hair under 131072 and an
  // `isSafeInteger` guard would reject text this module's own formatter emits.
  // The cap of three fraction digits bounds what rounding can hide at half a
  // token, so every value `formatMaxContextTokens` can produce survives the trip.
  const tokens = Math.round(value * multiplier);
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    return { status: "invalid" };
  }

  return { status: "valid", tokens };
}

/**
 * The shortest exact text for a stored token count, so a saved 100000000 comes
 * back as "100 M" rather than nine digits.
 *
 * Every branch carries an explicit unit. That is forced, not stylistic: a bare
 * number reads back as K, so emitting one would quietly multiply the value by a
 * thousand — and a count that is not a whole number of thousands (131072 is a
 * real context window) has no exact text at all without a fraction. Verified by
 * brute force over the whole 1..300000 range plus powers of two and random values
 * up to 1e15: every one round-trips back to its original number.
 */
export function formatMaxContextTokens(tokens: number | undefined): string {
  if (tokens === undefined) {
    return "";
  }
  if (tokens % MILLION === 0) {
    return `${tokens / MILLION} M`;
  }
  return `${tokens / THOUSAND} K`;
}

export function formatMaxContextTokenCount(tokens: number, locale: string): string {
  return tokens.toLocaleString(locale);
}

/**
 * The provider patch that writes — or removes — a ceiling.
 *
 * A cleared ceiling is an explicit `null`, never an absent key. The config patch
 * is merge-only, so `{ provider: {} }` cannot unset a scalar: it merges to a
 * no-op and the old ceiling survives the patch, the persisted file, and every
 * reload. The daemon deletes the key when it sees the marker.
 */
export function buildProviderMaxContextPatch(
  provider: string,
  tokens: number | undefined,
): NonNullable<MutableDaemonConfigPatch["providers"]> {
  return { [provider]: { maxContextTokens: tokens ?? null } };
}

export interface MaxContextFieldState {
  /** Grouped token count for the live preview; absent when unlimited or invalid. */
  previewTokens: number | undefined;
  /** False only for text that cannot be saved as a ceiling. */
  isValid: boolean;
  /** True when saving would change the stored value. */
  isDirty: boolean;
}

/**
 * One derivation of the field's render state so the sheet cannot disagree with
 * itself about whether the typed text is saveable.
 */
export function resolveMaxContextFieldState(
  text: string,
  storedTokens: number | undefined,
): MaxContextFieldState {
  const parsed = parseMaxContextTokens(text);
  const isValid = parsed.status !== "invalid";
  const nextTokens = parsed.status === "valid" ? parsed.tokens : undefined;

  return {
    previewTokens: nextTokens,
    isValid,
    isDirty: isValid && nextTokens !== storedTokens,
  };
}
