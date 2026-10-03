import { createHash } from "node:crypto";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { CtxInjectChipData } from "../shared/ctx-schema.js";

/**
 * Capture of what context an agent was CONFIGURED with, reduced to facts that
 * are safe to persist as chat history.
 *
 * This module is the only place the configured system prompt is ever held, and
 * it is server-only (`node:crypto`). Client code must never import it: the
 * client reads the already-reduced fields off the timeline row. Per owner
 * decision d-893c722f28 the prompt text itself is NOT stored — only its length
 * and a short hash. There is intentionally no preview/extract helper here; if
 * one is ever needed it must be opt-in and fetched on demand, never written
 * onto the row.
 */

/** Hex chars of the digest kept. Long enough to compare, not a fingerprint. */
export const HASH_CHARS = 12;

/** MCP names are bounded so a pathological config cannot bloat the row. */
export const MCP_NAMES_MAX = 64;

/** Non-reversible digest prefix, so two captures can be compared without the text. */
export function systemPromptHash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, HASH_CHARS);
}

/**
 * Characters per token in the dsh heuristic.
 *
 * A rough average across English prose and code, and the same divisor the
 * trajectory ledger's ported layout uses. It is a GUESS: real tokenizers vary
 * by content and by provider, and this plugin has no tokenizer and no right to
 * the text. Every number derived from it therefore ships as an
 * `estimated: true` (the schema makes that flag a `z.literal`, so it cannot be
 * dropped), and the chip labels it as an estimate in the copy too.
 */
export const CHARS_PER_TOKEN = 4;

/** Chars to an estimated token count. 0 chars is 0 tokens; nothing unknown. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Reduced facts from an `agent.create` session config. */
export interface ConfigFacts {
  systemPromptInjected: boolean;
  systemPromptLength: number;
  systemPromptHash: string | null;
  mcpServers: string[];
  /**
   * Model and mode AS CONFIGURED at creation. They attach to the agent record
   * after `agent.created` fires, so reading them from a snapshot there yields
   * em dashes; the create config already carries them, with no timing
   * dependency. A later model change on the agent will not be reflected, which
   * is correct for a row that documents what the session was created with.
   */
  model: string | null;
  modeId: string | null;
}

/**
 * Derive capture facts from a session config. Only names, counts and sizes are
 * produced — never prompt text, and never MCP config values (their commands and
 * URLs may carry secrets).
 */
export function configFacts(config: AgentSessionConfig | null | undefined): ConfigFacts {
  const prompt =
    typeof config?.systemPrompt === "string" && config.systemPrompt.length > 0
      ? config.systemPrompt
      : null;
  const names = config?.mcpServers ? Object.keys(config.mcpServers).sort() : [];
  return {
    systemPromptInjected: prompt !== null,
    systemPromptLength: prompt === null ? 0 : prompt.length,
    systemPromptHash: prompt === null ? null : systemPromptHash(prompt),
    mcpServers: names.slice(0, MCP_NAMES_MAX),
    model: config?.model ?? null,
    modeId: config?.modeId ?? null,
  };
}

/** Agent controls read from the snapshot at session-open time. */
export interface SnapshotControls {
  model: string | null;
  currentModeId: string | null;
}

/**
 * Merge create-hook facts + the agent snapshot into the chip payload.
 *
 * Model and mode prefer the CONFIGURED value from the create hook: it is known
 * before the agent is committed, and the row documents what the session was
 * created with. The live snapshot is the fallback for a session that never ran
 * the create hook (resume/refresh/import), read at append time when the agent
 * is actually available.
 *
 * `facts === null` means the create hook was never correlated — a resumed,
 * refreshed or imported agent. That is genuinely unknown, so every prompt field
 * becomes null rather than 0, and the reason travels with the row so the chip can
 * explain the gap instead of implying an empty prompt.
 *
 * The token estimate is derived from the captured LENGTH, which is the only
 * measurement of the prompt this module is allowed to keep. It is null whenever
 * the length is unknown, and it never covers MCP servers: only their names were
 * captured, and a token count derived from names would describe content this
 * plugin cannot see.
 */
export function buildChipData(input: {
  facts: ConfigFacts | null;
  snapshot: SnapshotControls | null;
  paseoToolsInjected: boolean | null;
  reason: string;
  capturedAt: string;
}): CtxInjectChipData {
  const promptLengthKnown =
    input.facts !== null && input.facts.systemPromptInjected === true
      ? input.facts.systemPromptLength
      : null;
  return {
    systemPromptInjected: input.facts ? input.facts.systemPromptInjected : null,
    systemPromptLength: input.facts ? input.facts.systemPromptLength : null,
    systemPromptHash: input.facts ? input.facts.systemPromptHash : null,
    tokenEstimates: {
      systemPrompt:
        promptLengthKnown === null
          ? null
          : { tokens: estimateTokensFromChars(promptLengthKnown), estimated: true },
    },
    mcpServers: input.facts ? input.facts.mcpServers : [],
    paseoToolsInjected: input.paseoToolsInjected,
    model: input.facts?.model ?? input.snapshot?.model ?? null,
    modeId: input.facts?.modeId ?? input.snapshot?.currentModeId ?? null,
    reason: input.reason,
    capturedAt: input.capturedAt,
  };
}
