import type { Logger } from "pino";

import type { ACPConfigFeatureOption } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface FreebuffACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
}

// Read-only: the adapter puts "<account> · <remaining>/<limit> daily" in the
// single option's name, so the feature selector doubles as the account/quota readout.
export const FREEBUFF_ACCOUNT_FEATURE_OPTION: ACPConfigFeatureOption = {
  id: "account",
  configId: "account",
  label: "Account",
  description: "Logged-in Freebuff account and remaining Freebucks",
  tooltip: "Freebuff account and today's remaining quota",
  icon: "wallet",
};

export const FREEBUFF_CONFIRM_OPEN_FEATURE_OPTION: ACPConfigFeatureOption = {
  id: "confirm_open",
  configId: "confirm_open",
  label: "Session open",
  description: "Ask before a new credit-spending free session is opened",
  tooltip: "Enable or disable the confirmation shown before a new Freebuff session opens",
  icon: "shield-check",
};

/**
 * Freebuff ACP adapter: generic ACP plus the account/quota and confirm-open features.
 *
 * Per-provider settings (supportsMcpServers, clientCapabilities) are NOT passed to the
 * constructor. They arrive per session on `config.providerOptions` and are parsed by
 * ACPProviderOptionsSchema inside ACPAgentClient, which is the single mechanism shared
 * with the pi and omp adapters. A provider override's `options` or legacy `params`
 * record reaches it through ResolvedProvider.providerOptions.
 */
export class FreebuffACPAgentClient extends GenericACPAgentClient {
  constructor(options: FreebuffACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      configFeatureOptions: [FREEBUFF_ACCOUNT_FEATURE_OPTION, FREEBUFF_CONFIRM_OPEN_FEATURE_OPTION],
    });
  }
}

/** Provider ids that run the freebuff-acp adapter (`freebuff`, `freebuff-acct2`, ...). */
export function isFreebuffACPProviderId(providerId: string): boolean {
  return providerId === "freebuff" || providerId.startsWith("freebuff-acct");
}
