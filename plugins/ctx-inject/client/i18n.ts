/**
 * Plugin-local strings. Plugins are not app workspace members, so they cannot
 * reach the app's i18n bundle; this map keeps the copy in one place and lets a
 * later locale be added without touching the component or any core file.
 */

const en = {
  badge: "Context configured",
  promptSummary: "prompt {{count}} chars",
  promptAbsent: "no system prompt",
  promptUnknown: "prompt unknown",
  mcpSummary_one: "{{count}} MCP server",
  mcpSummary_other: "{{count}} MCP servers",
  mcpNone: "no MCP servers",
  unknown: "—",

  detailPrompt: "System prompt",
  detailPromptNotConfigured: "not configured",
  detailPromptValue: "{{count}} chars · sha256:{{hash}}",
  detailPromptUnknown: "unknown for this session",
  /**
   * The estimate is labelled in the copy, not only on the wire: the number is
   * chars/4, and a reader who does not know that would take it for a real
   * tokenizer count.
   */
  detailPromptTokens: "Prompt tokens",
  detailPromptTokensValue: "~{{count}} (estimated, chars÷4)",
  detailMcp: "MCP servers",
  detailPaseoTools: "Paseo tools",
  detailModel: "Model",
  detailMode: "Mode",
  detailSession: "Session",
  detailCaptured: "Captured",

  yes: "yes",
  no: "no",

  /**
   * The honesty line. Paseo derives its own daemon prompt and runtime tools
   * after these hooks run, so no plugin can observe them. Rendered on the row
   * itself rather than behind the expand toggle: a caveat the user has to
   * discover is not a disclosure.
   */
  caveat:
    "Configured context only. Paseo's own prompt and runtime tools are added after this point and are not shown.",

  expand: "Show context detail",
  collapse: "Hide context detail",
} as const;

export type StringKey = keyof typeof en;
export type Locale = "en";

export const STRINGS: Record<Locale, Record<StringKey, string>> = { en };

type Vars = Record<string, string | number>;

/**
 * Tiny `{{placeholder}}` interpolation — enough for counts, no i18n runtime.
 * Double braces match the i18next convention the app uses, and keep a literal
 * `{` in copy from being mistaken for a placeholder.
 */
export function t(locale: Locale, key: StringKey, vars: Vars = {}): string {
  const template = STRINGS[locale][key] ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** Count-aware server summary, picking the `_one` / `_other` variant. */
export function tCount(locale: Locale, base: "mcpSummary", count: number, vars: Vars = {}): string {
  const table = STRINGS[locale] as Record<string, string>;
  const variant = count === 1 ? `${base}_one` : `${base}_other`;
  return t(locale, (table[variant] ? variant : base) as StringKey, { ...vars, count });
}
