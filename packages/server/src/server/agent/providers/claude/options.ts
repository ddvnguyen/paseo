import type { ProviderOptions, ToolPolicy } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

const PermissionRulesSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    ask: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

const SandboxNetworkSchema = z
  .object({
    allowedDomains: z.array(z.string()).optional(),
    deniedDomains: z.array(z.string()).optional(),
    strictAllowlist: z.boolean().optional(),
    allowManagedDomainsOnly: z.boolean().optional(),
    allowUnixSockets: z.array(z.string()).optional(),
    allowAllUnixSockets: z.boolean().optional(),
    allowLocalBinding: z.boolean().optional(),
    allowMachLookup: z.array(z.string()).optional(),
    httpProxyPort: z.number().int().positive().optional(),
    socksProxyPort: z.number().int().positive().optional(),
    tlsTerminate: z
      .object({
        caCertPath: z.string().optional(),
        caKeyPath: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const SandboxFilesystemSchema = z
  .object({
    allowWrite: z.array(z.string()).optional(),
    denyWrite: z.array(z.string()).optional(),
    denyRead: z.array(z.string()).optional(),
    allowRead: z.array(z.string()).optional(),
    allowManagedReadPathsOnly: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

// Claude Agent SDK Options, maintained against @anthropic-ai/claude-agent-sdk 0.3.246.
export const ClaudeProviderOptionsSchema = z
  .object({
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    additionalDirectories: z.array(z.string()).optional(),
    extraArgs: z.record(z.string(), z.string().nullable()).optional(),
    sandbox: z
      .object({
        enabled: z.boolean().optional(),
        failIfUnavailable: z.boolean().optional(),
        autoAllowBashIfSandboxed: z.boolean().optional(),
        excludedCommands: z.array(z.string()).optional(),
        allowUnsandboxedCommands: z.boolean().optional(),
        network: SandboxNetworkSchema.optional(),
        filesystem: SandboxFilesystemSchema.optional(),
        ignoreViolations: z.record(z.string(), z.array(z.string())).optional(),
        enableWeakerNestedSandbox: z.boolean().optional(),
        ripgrep: z
          .object({ command: z.string(), args: z.array(z.string()).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    settings: z
      .object({
        permissions: PermissionRulesSchema.optional(),
        sandbox: z
          .object({
            enabled: z.boolean().optional(),
            failIfUnavailable: z.boolean().optional(),
            autoAllowBashIfSandboxed: z.boolean().optional(),
            excludedCommands: z.array(z.string()).optional(),
            allowUnsandboxedCommands: z.boolean().optional(),
            network: SandboxNetworkSchema.optional(),
            filesystem: SandboxFilesystemSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<ProviderOptions>;

export type ClaudeProviderOptions = z.infer<typeof ClaudeProviderOptionsSchema>;

// The SDK forwards every extraArgs key verbatim as `--<key> <value>` on the claude argv, so this
// key becomes the `--autocompact` flag.
const CLAUDE_AUTO_COMPACT_ARG = "autocompact";
// claude 2.1.285 parses --autocompact with these bounds and *throws* on anything outside them,
// which fails the agent at startup rather than degrading. Verified from the installed binary: the
// flag parser (yxt) returns undefined for r < 1e5 or r > 1e6, and the argParser turns that into
// "It must be 'auto', or between 100k and 1M". Translate into the range here instead of passing
// the configured number through.
const CLAUDE_AUTO_COMPACT_MIN_TOKENS = 100_000;
const CLAUDE_AUTO_COMPACT_MAX_TOKENS = 1_000_000;

/**
 * Lower Claude Code's auto-compact window to a provider-level context cap.
 *
 * Claude Code's effective window is `min(modelContextWindow, autoCompactWindow)`, so setting the
 * auto-compact window is the only channel through which a cap reaches this harness — and it can
 * only lower the window, never raise it. Enforcement is by summarization, not by refusing turns:
 * the cap makes the session compact earlier than the model window would.
 *
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is deliberately NOT used. Despite the name it only applies to
 * model IDs Claude Code does not recognize; for real `claude-*` IDs it is inert. The output-token
 * knobs (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `MAX_THINKING_TOKENS`) bound a single response and are
 * likewise unrelated to the conversation window.
 *
 * A user-supplied `autocompact` in `extraArgs` wins over the derived cap — explicit beats implicit —
 * and every other user extraArgs key is preserved.
 */
export function applyClaudeContextCap(
  options: ClaudeProviderOptions,
  maxContextTokens: number | undefined,
): ClaudeProviderOptions {
  if (maxContextTokens === undefined) return options;
  const extraArgs = options.extraArgs;
  if (extraArgs && CLAUDE_AUTO_COMPACT_ARG in extraArgs) return options;
  // Above the ceiling the cap cannot lower any window Claude Code can currently run, and the
  // parser rejects the flag outright. Emitting nothing matches `min(modelWindow, cap)` exactly and
  // avoids capping a future model whose window exceeds 1M — which the harness cannot express.
  if (maxContextTokens > CLAUDE_AUTO_COMPACT_MAX_TOKENS) return options;
  // ACCEPTED LIMITATION: a cap below 100k is raised to 100k. The parser rejects anything smaller,
  // so a sub-100k user cap cannot be expressed on this harness at all, and the resulting window is
  // *higher* than the user asked for. The floor belongs to the CLI, not to Paseo — auto-compaction
  // is the only enforcement mechanism available here, and it has a 100k floor. Sub-100k caps are
  // meaningful on providers whose harness accepts them, not on Claude.
  const tokens = Math.max(CLAUDE_AUTO_COMPACT_MIN_TOKENS, maxContextTokens);
  return { ...options, extraArgs: { ...extraArgs, [CLAUDE_AUTO_COMPACT_ARG]: String(tokens) } };
}

export function applyClaudeToolPolicy(
  options: ClaudeProviderOptions,
  toolPolicy: ToolPolicy | undefined,
): ClaudeProviderOptions {
  if (!toolPolicy) return options;
  const allowedTools = Array.isArray(options.allowedTools)
    ? options.allowedTools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const grants = toolPolicy.preapproved.map((grant) => `mcp__${grant.server}__${grant.tool}`);
  return { ...options, allowedTools: [...new Set([...allowedTools, ...grants])] };
}
