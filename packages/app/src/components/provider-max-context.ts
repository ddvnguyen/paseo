/**
 * Parsing and formatting for a provider's `maxContextTokens` ceiling.
 *
 * Config stores a token count. Users think in "100 M" / "128 K", so the field
 * accepts a suffixed number and the config keeps the integer. Nothing here
 * touches React or the daemon — the settings sheet renders these results and
 * dispatches the save, which is the same split the schedule form uses.
 */

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

const MAX_CONTEXT_TOKENS_PATTERN = /^(\d+)\s*([km])?$/i;

export type MaxContextTokensInput =
  | { status: "empty" }
  | { status: "valid"; tokens: number }
  | { status: "invalid" };

/**
 * Whitespace-tolerant and case-insensitive: "100 M", " 100m ", and "128000" all
 * parse. A bare integer is a token count. Anything else — a sign, a decimal
 * point, a unit Paseo does not define — is invalid and must not be saved. Empty
 * is a distinct valid state meaning "no limit", because clearing the textbox is
 * how a user removes the cap.
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

  const [digits, suffix] = match.slice(1) as [string, Suffix | undefined];
  const multiplier = suffix ? SUFFIX_MULTIPLIERS[suffix.toLowerCase() as Suffix] : 1;
  const tokens = Number(digits) * multiplier;
  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    return { status: "invalid" };
  }

  return { status: "valid", tokens };
}

/**
 * The shortest exact text for a stored token count, so a saved 100000000 comes
 * back as "100 M" rather than nine digits. Every branch round-trips through
 * `parseMaxContextTokens` back to the same number.
 */
export function formatMaxContextTokens(tokens: number | undefined): string {
  if (tokens === undefined) {
    return "";
  }
  if (tokens % MILLION === 0) {
    return `${tokens / MILLION} M`;
  }
  if (tokens % THOUSAND === 0) {
    return `${tokens / THOUSAND} K`;
  }
  return String(tokens);
}

export function formatMaxContextTokenCount(tokens: number, locale: string): string {
  return tokens.toLocaleString(locale);
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
