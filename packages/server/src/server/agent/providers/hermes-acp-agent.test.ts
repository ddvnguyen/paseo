import { beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";

const mockState = vi.hoisted(() => ({
  superConstructorOptions: [] as unknown[],
}));

vi.mock("./generic-acp-agent.js", () => ({
  GenericACPAgentClient: class GenericACPAgentClient {
    readonly provider: string;

    constructor(options: unknown) {
      this.provider = "acp";
      mockState.superConstructorOptions.push(options);
    }
  },
}));

import { HermesACPAgentClient } from "./hermes-acp-agent.js";

describe("HermesACPAgentClient", () => {
  beforeEach(() => {
    mockState.superConstructorOptions = [];
  });

  test("forwards the command and injects HERMES_ACP_SKIP_CONFIGURED_MCP", () => {
    const _client = new HermesACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes", "acp"],
      env: {
        HERMES_LOG: "info",
      },
      providerId: "hermes",
      label: "Hermes",
    });
    void _client;

    expect(mockState.superConstructorOptions).toEqual([
      {
        logger: expect.any(Object),
        command: ["hermes", "acp"],
        env: {
          HERMES_LOG: "info",
          HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
        },
        providerId: "hermes",
        label: "Hermes",
        providerParams: undefined,
        waitForInitialCommands: true,
        initialCommandsWaitTimeoutMs: 10_000,
      },
    ]);
  });

  test("does not overwrite a host-set HERMES_ACP_SKIP_CONFIGURED_MCP value", () => {
    const _client = new HermesACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes-acp"],
      env: {
        HERMES_ACP_SKIP_CONFIGURED_MCP: "0",
      },
    });
    void _client;

    expect(mockState.superConstructorOptions).toEqual([
      {
        logger: expect.any(Object),
        command: ["hermes-acp"],
        env: {
          HERMES_ACP_SKIP_CONFIGURED_MCP: "0",
        },
        providerId: undefined,
        label: undefined,
        providerParams: undefined,
        waitForInitialCommands: true,
        initialCommandsWaitTimeoutMs: 10_000,
      },
    ]);
  });
});
