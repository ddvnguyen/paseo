import { z } from "zod";

/**
 * Wire contract for the context-inject chip.
 *
 * PRIVACY (owner decision d-893c722f28): the configured system prompt is
 * NEVER stored or transmitted. Only its length, a short non-reversible hash,
 * and MCP server NAMES leave the server. There is deliberately no preview
 * field — a stored preview would become persisted and relayed chat history,
 * which is a wider blast radius than the configured-prompt facts above. Do not
 * add one; if a preview is ever wanted it must be fetched on demand, never
 * persisted onto the row.
 *
 * FIDELITY CEILING: these are the facts Paseo *hands to the provider*, i.e.
 * the agent configuration. Paseo's own daemon prompt and runtime tools are
 * derived between the `agent.create` and `agent.session_open` hooks and are
 * not observable by any plugin (see the ordering in
 * public-docs/plugins/reference.md). The chip discloses this in its copy
 * rather than implying the numbers are the whole story.
 *
 * Every nullable field means "unknown", never "zero" or "none": a resumed or
 * imported agent correlates no create-hook facts, and an unreadable daemon
 * config is not the same as a disabled feature. All of them render as "—".
 */
export const CtxInjectChipDataSchema = z.object({
  /** true only when a non-empty systemPrompt was configured at create time. */
  systemPromptInjected: z.boolean().nullable(),
  systemPromptLength: z.number().int().nonnegative().nullable(),
  /** sha256 of the configured prompt, first 12 hex chars. Never the prompt. */
  systemPromptHash: z.string().nullable(),
  /** MCP server names only — never their config, whose commands/URLs may carry secrets. */
  mcpServers: z.array(z.string()),
  /** providers[provider].paseoTools.enabled; null when unset or unreadable. */
  paseoToolsInjected: z.boolean().nullable(),
  model: z.string().nullable(),
  modeId: z.string().nullable(),
  /** Session-open reason: create | resume | refresh | import. Explains missing facts. */
  reason: z.string(),
  /** ISO-8601, so the row can say how old the capture is. */
  capturedAt: z.string(),
});

export type CtxInjectChipData = z.infer<typeof CtxInjectChipDataSchema>;

/** Renderer contract version; bump only with a matching schema change. */
export const CTX_INJECT_KIND = "ctx-inject";
export const CTX_INJECT_VERSION = 1;

/**
 * Timeline row id. Constant per agent so repeated session opens REPLACE the
 * row instead of stacking a new chip on every resume.
 */
export const CTX_INJECT_ROW_ID = "ctx-inject";
