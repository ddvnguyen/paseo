import type { Logger } from "pino";

import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface HermesACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const HERMES_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;

/**
 * hermes-agent (Nous Research) exposes a standard Agent Client Protocol server via
 * `hermes acp`. It advertises edit-approval modes (`default`/`accept_edits`/`dont_ask`),
 * streams reasoning through `agent_thought_chunk`, and publishes slash commands
 * asynchronously through `available_commands_update` after session creation — so the
 * initial-commands wait applies here, as it does for Cursor.
 *
 * ACP hosts should skip hermes's globally-configured MCP servers before the JSON-RPC loop
 * (set `HERMES_ACP_SKIP_CONFIGURED_MCP=1`), otherwise a slow or interactive global MCP
 * server delays `initialize`. MCP servers passed via `session/new` are still registered.
 */
export class HermesACPAgentClient extends GenericACPAgentClient {
  constructor(options: HermesACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: {
        ...options.env,
        // A host that explicitly sets this to "0" opts into hermes's global MCP servers.
        HERMES_ACP_SKIP_CONFIGURED_MCP: options.env?.HERMES_ACP_SKIP_CONFIGURED_MCP ?? "1",
      },
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: HERMES_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
    });
  }
}
