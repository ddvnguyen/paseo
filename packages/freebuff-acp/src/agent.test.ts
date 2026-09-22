import { describe, expect, it, vi } from "vitest";

import { FreebuffAcpAgent } from "./agent.js";

function makeConn() {
  return { sessionUpdate: vi.fn(async () => {}) };
}

/** Minimal fake of the CodebuffClient surface the adapter touches. */
function makeClient(output: { type: string; message?: string }) {
  return {
    run: vi.fn(async (options: Record<string, unknown>) => {
      const handleEvent = options.handleEvent as ((event: unknown) => void) | undefined;
      handleEvent?.({ type: "text", text: "hello" });
      return { sessionState: { marker: 1 }, output };
    }),
  };
}

describe("FreebuffAcpAgent", () => {
  it("initializes with loadSession disabled and an auth method", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), {});
    const response = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    } as never);
    expect(response.protocolVersion).toBe(1);
    expect(response.agentCapabilities?.loadSession).toBe(false);
    expect(response.authMethods?.[0]?.id).toBe("freebuff-login");
  });

  it("fails newSession with a clear error when unauthenticated", async () => {
    // A relative FREEBUFF_CONFIG_DIR disables both env keys and the real CLI
    // credential store, keeping the test hermetic on machines where the host
    // has CODEBUFF_API_KEY exported or the user is logged in to freebuff.
    const agent = new FreebuffAcpAgent(makeConn(), {
      FREEBUFF_API_KEY: "",
      CODEBUFF_API_KEY: "",
      FREEBUFF_CONFIG_DIR: "relative-must-be-ignored",
    });
    await expect(agent.newSession({ cwd: "/tmp", mcpServers: [] } as never)).rejects.toThrow(
      /not authenticated/i,
    );
  });

  it("creates sessions with the lite mode and streams a turn", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), { CODEBUFF_API_KEY: "k" });
    (agent as unknown as { ensureClient: () => unknown }).ensureClient = () =>
      makeClient({ type: "success" });

    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    expect(session.modes?.currentModeId).toBe("lite");

    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);
    expect(response.stopReason).toBe("end_turn");
  });

  it("rejects an unknown mode", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), { CODEBUFF_API_KEY: "k" });
    (agent as unknown as { ensureClient: () => unknown }).ensureClient = () =>
      makeClient({ type: "success" });
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    await expect(
      agent.setSessionMode({ sessionId: session.sessionId, modeId: "bogus" }),
    ).rejects.toThrow(/unknown mode/i);
  });

  it("cancel on an unknown session is a no-op", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), {});
    await expect(agent.cancel({ sessionId: "nope" })).resolves.toBeUndefined();
  });
});
