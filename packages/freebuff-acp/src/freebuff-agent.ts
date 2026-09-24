/**
 * Bundled Freebuff CLI root agent definitions.
 *
 * The backend's free mode only allows allowlisted agents (`base2-free-*` /
 * `base3-free-*`), and those definitions are NOT in the public agent registry
 * — the Freebuff CLI ships them compiled into its binary and passes them to
 * the SDK as `agentDefinitions`. This module mirrors the upstream base3
 * definitions (CodebuffAI/freebuff `agents/base3.ts` createBase3CliRoot +
 * `common/constants/free-agents.ts` FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL) so
 * the adapter can do the same. `{CODEBUFF_*}` placeholders are filled in by
 * the SDK runtime.
 */
import type { AgentDefinition } from "@codebuff/sdk";

export const FREEBUFF_GLM_53_FLASH_MODEL_ID = "z-ai/glm-5.3-flash";

/**
 * Picker model id -> CLI base3 root agent id.
 * Mirrors FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL upstream.
 */
export const FREEBUFF_AGENT_ID_BY_MODEL: Record<string, string> = {
  "deepseek/deepseek-v4-pro": "base3-free-deepseek",
  "deepseek/deepseek-v4-flash": "base3-free-deepseek-flash",
  "mimo/mimo-v2.5": "base3-free-mimo",
  "mimo/mimo-v2.6-pro": "base3-free-mimo-2-6-pro",
  "minimax/minimax-m3": "base3-free-minimax-m3",
  "openai/gpt-5.6-luna": "base3-free-luna",
  "z-ai/glm-5.2": "base3-free-glm",
  "z-ai/glm-5.3-flash": "base3-free-glm-5-3-flash",
  "upstage/solar-pro4": "base3-free-solar-pro4",
  "google/gemini-3.8-flash": "base3-free-gemini-3-8-flash",
  "meta/muse-spark-1.3-contributor": "base3-free-muse-spark-1-3",
  "meta/muse-spark-1.2-contributor": "base3-free-muse-spark",
  "openai/gpt-6-luna": "base3-free-luna-6",
  "upstage/solar-mini4": "base3-free-solar-mini4",
  "stealth/ox-alpha": "base3-free-ox-alpha",
  "stealth/space-bunny-alpha": "base3-free-space-bunny-alpha",
};

export const DEFAULT_FREEBUFF_MODEL = FREEBUFF_GLM_53_FLASH_MODEL_ID;

export function agentIdForModel(model: string): string | null {
  return FREEBUFF_AGENT_ID_BY_MODEL[model] ?? null;
}

function rootAgentFor(agentId: string, model: string, displayName: string): AgentDefinition {
  return {
    id: agentId,
    publisher: "codebuff",
    model,
    providerOptions: { data_collection: "deny" },
    displayName,
    spawnerPrompt:
      "Single-loop coding agent that explores, edits, and verifies directly with its own tools",
    inputSchema: {
      prompt: {
        type: "string",
        description: "A coding task to complete",
      },
    },
    outputMode: "last_message",
    includeMessageHistory: true,
    toolNames: [
      "read_files",
      "str_replace",
      "write_file",
      "run_terminal_command",
      "code_search",
      "glob",
      "list_directory",
      "write_todos",
      "web_search",
      "read_url",
      "ask_user",
      "suggest_followups",
      // Official Freebuff free-agent surface also exposes skill (and
      // gravity_index / render_ui). skill is fully handled client-side by
      // @codebuff/sdk; skills load from ~/.agents/skills and {cwd}/.agents/skills.
      "skill",
    ],
    systemPrompt: `You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.

Current date: {CODEBUFF_CURRENT_DATE}.

- Match the project's existing conventions. Verify a library is already used in the project before employing it.
- Prefer editing existing files over creating new ones. Make the fewest changes that address the request.
- Verify non-trivial changes by running the project's typecheck and relevant tests.
- Use write_todos to plan and track multi-step tasks.
- Your responses are displayed in a terminal. Keep them short and concise.
- Don't run destructive or hard-to-undo commands (git push, resets, deploys) unless the user asks for them.

{CODEBUFF_KNOWLEDGE_FILES_CONTENTS}

{CODEBUFF_GIT_CHANGES_PROMPT}

# Freebuff Meta-information

You are running on the ${model} model.

You are the AI agent behind Freebuff, a tool where users can chat with you to code with AI for free. See freebuff.com for more information about the product.

{CODEBUFF_SYSTEM_INFO_PROMPT}
`,
  };
}

/** Every bundled root definition, one per picker model. */
export const FREEBUFF_ROOT_DEFINITIONS: AgentDefinition[] = Object.entries(
  FREEBUFF_AGENT_ID_BY_MODEL,
).map(([model, agentId]) => rootAgentFor(agentId, model, `Buffy on ${model}`));

/** Back-compat single root (GLM 5.3 Flash). */
export const FREEBUFF_ROOT_AGENT_ID = "base3-free-glm-5-3-flash";
export const freebuffRootAgentDefinition = rootAgentFor(
  FREEBUFF_ROOT_AGENT_ID,
  FREEBUFF_GLM_53_FLASH_MODEL_ID,
  "Buffy on GLM 5.3 Flash",
);
