import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FreebuffAcpAgent } from "./agent.js";
import { loadPersistedSession, savePersistedSession } from "./session-store.js";

/** Resolve a fetch() input (string | URL | Request) to a string href. */
function hrefOf(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return String((url as Request).url ?? url);
}

// The turn now performs the free-session admission dance before running.
// Stub the HTTP layer so tests stay hermetic and offline.
const fetchMock = vi.fn(async (url: string | URL | Request) => {
  const href = hrefOf(url);
  if (href.endsWith("/admission") || href.includes("/session/admission")) {
    return new Response(
      JSON.stringify({ status: "active", instanceId: "inst-1", model: "z-ai/glm-5.3-flash" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  // Probe GET /session → none so admission POST is exercised by default.
  return new Response(JSON.stringify({ status: "none" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
vi.stubGlobal("fetch", fetchMock);

let stateDir = "";

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-acp-state-"));
});

afterEach(() => {
  fetchMock.mockClear();
  fetchMock.mockReset();
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    stateDir = "";
  }
  // Restore suite default: admission → active, probe → none, else {}.
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const href = hrefOf(url);
    if (href.endsWith("/admission") || href.includes("/session/admission")) {
      return new Response(
        JSON.stringify({ status: "active", instanceId: "inst-1", model: "z-ai/glm-5.3-flash" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (href.includes("/api/v1/freebuff/session")) {
      return new Response(JSON.stringify({ status: "none" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  });
});

function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CODEBUFF_API_KEY: "k",
    FREEBUFF_ACP_STATE_DIR: stateDir,
    ...extra,
  };
}

function makeConn() {
  return {
    sessionUpdate: vi.fn(async () => {}),
    // Auto-accept the open-session confirm so the suite's default POST-path
    // tests keep their admission behavior; individual tests override via
    // mockResolvedValueOnce to exercise the decline path.
    requestPermission: vi.fn(
      async (): Promise<{ outcome: { outcome: string; optionId?: string } }> => ({
        outcome: { outcome: "selected", optionId: "open-session" },
      }),
    ),
  };
}

/** Minimal fake of the CodebuffClient surface the adapter touches. */
function makeClient(output: { type: string; message?: string }) {
  return {
    run: vi.fn(async (options: Record<string, unknown>) => {
      const handleEvent = options.handleEvent as ((event: unknown) => void) | undefined;
      handleEvent?.({ type: "text", text: "hello" });
      return {
        sessionState: {
          marker: (options.previousRun as { marker?: number } | undefined)?.marker ?? 1,
        },
        output,
      };
    }),
  };
}

function stubClient(agent: FreebuffAcpAgent, client: ReturnType<typeof makeClient>) {
  (agent as unknown as { ensureClient: () => unknown }).ensureClient = () => ({
    client,
    token: "k",
  });
}

describe("FreebuffAcpAgent", () => {
  it("initializes with session/resume enabled and an auth method", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), testEnv());
    const response = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    } as never);
    expect(response.protocolVersion).toBe(1);
    expect(response.agentCapabilities?.loadSession).toBe(false);
    expect(response.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
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
      FREEBUFF_ACP_STATE_DIR: stateDir,
    });
    await expect(agent.newSession({ cwd: "/tmp", mcpServers: [] } as never)).rejects.toThrow(
      /not authenticated/i,
    );
  });

  it("creates sessions with the lite mode and streams a turn", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), testEnv());
    stubClient(agent, makeClient({ type: "success" }));

    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    expect(session.modes?.currentModeId).toBe("lite");

    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);
    expect(response.stopReason).toBe("end_turn");
    // The admission POST must have happened and the run must carry the slot.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/freebuff/session/admission"),
      expect.objectContaining({ method: "POST" }),
    );
    const runOptions = (
      agent as unknown as { sessions: Map<string, { client: { run: ReturnType<typeof vi.fn> } }> }
    ).sessions
      .values()
      .next().value?.client.run.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(runOptions?.extraCodebuffMetadata).toEqual({ freebuff_instance_id: "inst-1" });
    // Conversation state is persisted for session/resume after restart.
    const persisted = loadPersistedSession(session.sessionId, {
      FREEBUFF_ACP_STATE_DIR: stateDir,
    });
    expect(persisted?.runState).toEqual({ marker: 1 });
  });

  it("resumes a session from disk without blocking on an open free session", async () => {
    const env = testEnv();
    const sessionId = "freebuff-resume-1";
    savePersistedSession(
      {
        sessionId,
        cwd: "/tmp",
        modeId: "lite",
        runState: { sessionState: { prior: true }, output: { type: "lastMessage", value: [] } },
        updatedAt: new Date().toISOString(),
      },
      env,
    );

    const agent = new FreebuffAcpAgent(makeConn(), env);
    stubClient(agent, makeClient({ type: "success" }));

    const resumed = await agent.unstable_resumeSession({
      sessionId,
      cwd: "/tmp",
      mcpServers: [],
    } as never);
    expect(resumed.modes?.currentModeId).toBe("lite");

    const response = await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: "continue" }],
    } as never);
    expect(response.stopReason).toBe("end_turn");
    const runOptions = (
      agent as unknown as {
        sessions: Map<string, { client: { run: ReturnType<typeof vi.fn> } }>;
      }
    ).sessions.get(sessionId)!.client.run.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(runOptions.previousRun).toEqual({
      sessionState: { prior: true },
      output: { type: "lastMessage", value: [] },
    });
    expect(runOptions.extraCodebuffMetadata).toEqual({ freebuff_instance_id: "inst-1" });
  });

  it("adopts an already-open free session on another model instead of waiting", async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const href = hrefOf(url);
      if (href.includes("/session/admission")) {
        // Would be a wait if we POSTed over an open slot — must not be hit.
        return new Response(JSON.stringify({ status: "model_locked" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          status: "active",
          instanceId: "inst-open",
          model: "mimo/mimo-v2.5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const agent = new FreebuffAcpAgent(makeConn(), testEnv());
    const client = makeClient({ type: "success" });
    stubClient(agent, client);

    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);

    expect(response.stopReason).toBe("end_turn");
    // Reused open slot — no admission POST, no DELETE release of a foreign slot.
    const mutating = fetchMock.mock.calls.filter(([, init]) => {
      const opts = init as RequestInit | undefined;
      const method = typeof opts?.method === "string" ? opts.method.toUpperCase() : "GET";
      return method === "POST" || method === "DELETE";
    });
    expect(mutating).toHaveLength(0);
    const runOptions = client.run.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(runOptions.extraCodebuffMetadata).toEqual({ freebuff_instance_id: "inst-open" });
    // Root agent follows the open slot's catalog model.
    expect(runOptions.agent).toBe("base3-free-mimo");
  });

  it("soft-loads via loadSession without history replay", async () => {
    const env = testEnv();
    savePersistedSession(
      {
        sessionId: "freebuff-load-1",
        cwd: "/tmp",
        modeId: "lite",
        runState: { marker: 42 },
        updatedAt: new Date().toISOString(),
      },
      env,
    );
    const agent = new FreebuffAcpAgent(makeConn(), env);
    stubClient(agent, makeClient({ type: "success" }));
    const response = await agent.loadSession({
      sessionId: "freebuff-load-1",
      cwd: "/tmp",
      mcpServers: [],
    } as never);
    expect(response.modes?.currentModeId).toBe("lite");
    const session = (
      agent as unknown as { sessions: Map<string, { runState: unknown }> }
    ).sessions.get("freebuff-load-1");
    expect(session?.runState).toEqual({ marker: 42 });
  });

  it("surfaces the waiting room as a refusal and preserves state", async () => {
    // Probe (GET /session) → none; admission POST → rate_limited.
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const href = hrefOf(url);
      if (href.includes("/session/admission")) {
        return new Response(JSON.stringify({ status: "rate_limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ status: "none" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const agent = new FreebuffAcpAgent(makeConn(), testEnv());
    stubClient(agent, makeClient({ type: "success" }));
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);
    expect(response.stopReason).toBe("refusal");
  });

  it("asks before opening a new paid session and refuses when declined", async () => {
    // Suite default probe (GET /session → none); track any admission POST so
    // a regression that skips the confirm gate spends credit visibly here.
    const admitted: string[] = [];
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const href = hrefOf(url);
      if (href.includes("/session/admission")) {
        admitted.push(href);
        return new Response(
          JSON.stringify({ status: "active", instanceId: "inst-x", model: "z-ai/glm-5.3-flash" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ status: "none" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const conn = makeConn();
    conn.requestPermission.mockResolvedValueOnce({ outcome: { outcome: "cancelled" } });
    const agent = new FreebuffAcpAgent(conn, testEnv());
    stubClient(agent, makeClient({ type: "success" }));

    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);

    expect(response.stopReason).toBe("refusal");
    expect(conn.requestPermission).toHaveBeenCalledTimes(1);
    // A declined confirm must never spend credit: no admission POST, no run.
    expect(admitted).toHaveLength(0);
    expect(conn.sessionUpdate).toHaveBeenCalledWith({
      sessionId: expect.any(String),
      update: expect.objectContaining({
        sessionUpdate: "agent_message_chunk",
        content: expect.objectContaining({ text: expect.stringContaining("declined") }),
      }),
    });
  });

  it("streams live text and reasoning deltas and drops the duplicate flush", async () => {
    const conn = makeConn();
    const agent = new FreebuffAcpAgent(conn, testEnv());
    stubClient(agent, {
      run: vi.fn(async (options: Record<string, unknown>) => {
        const stream = options.handleStreamChunk as ((chunk: unknown) => void) | undefined;
        const event = options.handleEvent as ((evt: unknown) => void) | undefined;
        stream?.("Hello ");
        stream?.("world");
        stream?.({
          type: "reasoning_chunk",
          agentId: "run-1",
          ancestorRunIds: [],
          chunk: "thinking hard",
        });
        stream?.({ type: "subagent_chunk", agentId: "sub", agentType: "helper", chunk: "ignored" });
        // The SDK flushes the same text later as one {type:"text"} event; it
        // must not render a second time.
        event?.({ type: "text", text: "Hello world" });
        return { sessionState: { marker: 1 }, output: { type: "success" } };
      }),
    });

    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);

    expect(response.stopReason).toBe("end_turn");
    const chunkTexts = conn.sessionUpdate.mock.calls
      .map(([params]) => params?.update)
      .filter(
        (update) =>
          update?.sessionUpdate === "agent_message_chunk" ||
          update?.sessionUpdate === "agent_thought_chunk",
      )
      .map((update) => update.content?.text);
    // Two deltas + one reasoning chunk, in order; no subagent passthrough, no
    // duplicated flush.
    expect(chunkTexts).toEqual(["Hello ", "world", "thinking hard"]);
  });

  it("rejects an unknown mode", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), testEnv());
    stubClient(agent, makeClient({ type: "success" }));
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    await expect(
      agent.setSessionMode({ sessionId: session.sessionId, modeId: "bogus" }),
    ).rejects.toThrow(/unknown mode/i);
  });

  it("cancel on an unknown session is a no-op", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), {});
    await expect(agent.cancel({ sessionId: "nope" })).resolves.toBeUndefined();
  });

  it("serializes prompts process-wide across sessions and threads each turn's own instance id", async () => {
    let admissionCalls = 0;
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const href = hrefOf(url);
      if (href.includes("/session/admission")) {
        admissionCalls += 1;
        return new Response(
          JSON.stringify({
            status: "active",
            instanceId: `inst-${admissionCalls}`,
            model: "z-ai/glm-5.3-flash",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ status: "none" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const agent = new FreebuffAcpAgent(makeConn(), testEnv());

    const pending: Array<() => void> = [];
    const capturedHooks: Array<Record<string, string> | undefined> = [];
    const client = {
      run: vi.fn(async () => {
        capturedHooks.push(
          (globalThis as { __freebuffExtraCodebuffMetadata?: Record<string, string> })
            .__freebuffExtraCodebuffMetadata,
        );
        const gate = Promise.withResolvers<{
          sessionState: { marker: number };
          output: { type: string };
        }>();
        function release() {
          gate.resolve({ sessionState: { marker: 1 }, output: { type: "success" } });
        }
        pending.push(release);
        return gate.promise;
      }),
    };
    stubClient(agent, client as unknown as ReturnType<typeof makeClient>);

    const session1 = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    const session2 = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);

    const p1 = agent.prompt({
      sessionId: session1.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);
    await vi.waitFor(() => expect(client.run).toHaveBeenCalledTimes(1));

    const p2 = agent.prompt({
      sessionId: session2.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);
    // The second session's turn must not start while the lane is held by the first.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.run).toHaveBeenCalledTimes(1);

    pending[0]?.();
    await p1;
    await vi.waitFor(() => expect(client.run).toHaveBeenCalledTimes(2));
    pending[1]?.();
    await p2;

    expect(capturedHooks[0]).toEqual({ freebuff_instance_id: "inst-1" });
    expect(capturedHooks[1]).toEqual({ freebuff_instance_id: "inst-2" });
  });

  it("reports an SDK-aborted run (output.type=error) as cancelled, not refusal", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), testEnv());
    const client = {
      run: vi.fn(async (options: { signal: AbortSignal }) => {
        await new Promise<void>((resolve) =>
          options.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { sessionState: { marker: 7 }, output: { type: "error", message: "Aborted" } };
      }),
    };
    stubClient(agent, client as unknown as ReturnType<typeof makeClient>);
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);

    const pending = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);
    await vi.waitFor(() => expect(client.run).toHaveBeenCalledTimes(1));
    await agent.cancel({ sessionId: session.sessionId });

    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
  });

  it("settles a cancelled turn even when the SDK run never unwinds (tool ignores the signal)", async () => {
    vi.useFakeTimers();
    try {
      const agent = new FreebuffAcpAgent(makeConn(), testEnv());
      const client = { run: vi.fn(() => new Promise(() => undefined)) };
      stubClient(agent, client as unknown as ReturnType<typeof makeClient>);
      const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);

      const pending = agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hi" }],
      } as never);
      await vi.waitFor(() => expect(client.run).toHaveBeenCalledTimes(1));
      await agent.cancel({ sessionId: session.sessionId });
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops session updates emitted after the turn was cancelled", async () => {
    const conn = makeConn();
    const agent = new FreebuffAcpAgent(conn, testEnv());
    let lateEmit: ((event: unknown) => void) | undefined;
    const client = {
      run: vi.fn((options: { handleEvent: (event: unknown) => void; signal: AbortSignal }) => {
        lateEmit = options.handleEvent;
        return new Promise(() => undefined);
      }),
    };
    stubClient(agent, client as unknown as ReturnType<typeof makeClient>);
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);

    const pending = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);
    await vi.waitFor(() => expect(client.run).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    try {
      await agent.cancel({ sessionId: session.sessionId });
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      vi.useRealTimers();
    }
    await pending;
    lateEmit?.({ type: "text", text: "zombie output" });

    const texts = conn.sessionUpdate.mock.calls.map((call) => JSON.stringify(call));
    expect(texts.some((entry) => entry.includes("zombie output"))).toBe(false);
  });

  it("steers: a prompt sent mid-turn cancels the running turn and then runs, instead of failing as busy", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), testEnv());
    const prompts: string[] = [];
    const client = {
      run: vi.fn(async (options: { prompt: string; signal: AbortSignal }) => {
        prompts.push(options.prompt);
        if (prompts.length === 1) {
          await new Promise<void>((resolve) =>
            options.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return { sessionState: { marker: 1 }, output: { type: "error", message: "Aborted" } };
        }
        return { sessionState: { marker: 2 }, output: { type: "success" } };
      }),
    };
    stubClient(agent, client as unknown as ReturnType<typeof makeClient>);
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);

    const first = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "long task" }],
    } as never);
    await vi.waitFor(() => expect(client.run).toHaveBeenCalledTimes(1));
    const second = agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "actually do this instead" }],
    } as never);

    await expect(first).resolves.toMatchObject({ stopReason: "cancelled" });
    await expect(second).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(prompts).toEqual(["long task", "actually do this instead"]);
  });

  it("advertises image prompts, session listing, and the model catalog", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), testEnv());
    const init = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as never);
    expect(init.agentCapabilities?.promptCapabilities?.image).toBe(true);
    expect(init.agentCapabilities?.sessionCapabilities?.list).toEqual({});

    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    expect(session.models?.currentModelId).toBe("z-ai/glm-5.3-flash");
    expect(session.models?.availableModels.length).toBeGreaterThan(5);
  });

  it("switches model per session, persists it, and requests it at admission", async () => {
    // Admission grants whatever model was requested (a fresh slot).
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (hrefOf(url).includes("/session/admission")) {
        const requested = (init?.headers as Record<string, string>)["x-freebuff-model"];
        return new Response(
          JSON.stringify({ status: "active", instanceId: "inst-1", model: requested }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ status: "none" }), { status: 200 });
    });
    const agent = new FreebuffAcpAgent(makeConn(), testEnv());
    stubClient(agent, makeClient({ type: "success" }));
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);

    await expect(
      agent.unstable_setSessionModel({ sessionId: session.sessionId, modelId: "nope" } as never),
    ).rejects.toThrow(/unknown model/i);
    await agent.unstable_setSessionModel({
      sessionId: session.sessionId,
      modelId: "deepseek/deepseek-v4-flash",
    } as never);
    expect(loadPersistedSession(session.sessionId, testEnv())?.modelId).toBe(
      "deepseek/deepseek-v4-flash",
    );

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);
    const admission = fetchMock.mock.calls.find(([url]) =>
      hrefOf(url).includes("/session/admission"),
    );
    const headers = (admission?.[1] as { headers: Record<string, string> }).headers;
    expect(headers["x-freebuff-model"]).toBe("deepseek/deepseek-v4-flash");

    const resumed = new FreebuffAcpAgent(makeConn(), testEnv());
    const restored = await resumed.unstable_resumeSession({
      sessionId: session.sessionId,
      cwd: "/tmp",
      mcpServers: [],
    } as never);
    expect(restored.models?.currentModelId).toBe("deepseek/deepseek-v4-flash");
  });

  it("lists persisted sessions, newest first, filtered by cwd, with titles", async () => {
    const conn = makeConn();
    const agent = new FreebuffAcpAgent(conn, testEnv());
    stubClient(agent, makeClient({ type: "success" }));
    const a = await agent.newSession({ cwd: "/work/a", mcpServers: [] } as never);
    await agent.newSession({ cwd: "/work/b", mcpServers: [] } as never);
    await agent.prompt({
      sessionId: a.sessionId,
      prompt: [{ type: "text", text: "fix the flaky login test" }],
    } as never);

    const all = await agent.listSessions({} as never);
    expect(all.sessions).toHaveLength(2);
    const onlyA = await agent.listSessions({ cwd: "/work/a" } as never);
    expect(onlyA.sessions).toEqual([
      expect.objectContaining({ sessionId: a.sessionId, title: "fix the flaky login test" }),
    ]);
    expect(JSON.stringify(conn.sessionUpdate.mock.calls)).toContain("session_info_update");
  });

  it("announces slash commands and handles built-ins without running a turn", async () => {
    const conn = makeConn();
    const agent = new FreebuffAcpAgent(conn, testEnv());
    const client = makeClient({ type: "success" });
    stubClient(agent, client);
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    await vi.waitFor(() =>
      expect(JSON.stringify(conn.sessionUpdate.mock.calls)).toContain("available_commands_update"),
    );

    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "remember AXIOM" }],
    } as never);
    expect(client.run).toHaveBeenCalledTimes(1);

    const status = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/status" }],
    } as never);
    expect(status.stopReason).toBe("end_turn");
    const cleared = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "/clear" }],
    } as never);
    expect(cleared.stopReason).toBe("end_turn");
    expect(client.run).toHaveBeenCalledTimes(1);
    expect(loadPersistedSession(session.sessionId, testEnv())?.runState).toBeNull();
  });

  it("forwards image blocks to the run as multimodal content", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), testEnv());
    const client = makeClient({ type: "success" });
    stubClient(agent, client);
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [
        { type: "text", text: "what is this?" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    } as never);
    const options = client.run.mock.calls[0]?.[0] as { content?: unknown };
    expect(options.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", image: "aGVsbG8=", mediaType: "image/png" },
    ]);
  });

  it("maps write_todos to a plan and subagents to cards", async () => {
    const conn = makeConn();
    const agent = new FreebuffAcpAgent(conn, testEnv());
    const client = {
      run: vi.fn(async (options: { handleEvent: (event: unknown) => void }) => {
        options.handleEvent({
          type: "tool_call",
          toolCallId: "t1",
          toolName: "write_todos",
          input: { todos: [{ task: "step one", completed: false }] },
        });
        options.handleEvent({
          type: "subagent_start",
          agentId: "a1",
          agentType: "x",
          displayName: "Explorer",
          onlyChild: true,
        });
        options.handleEvent({
          type: "subagent_finish",
          agentId: "a1",
          agentType: "x",
          displayName: "Explorer",
          onlyChild: true,
        });
        return { sessionState: { mainAgentState: { contextTokenCount: 1234 } }, output: { type: "success" } };
      }),
    };
    stubClient(agent, client as unknown as ReturnType<typeof makeClient>);
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "go" }],
    } as never);

    const updates = conn.sessionUpdate.mock.calls.map(
      (call) => (call as unknown as [{ update: Record<string, unknown> }])[0].update,
    );
    expect(updates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: "plan",
        entries: [expect.objectContaining({ content: "step one", status: "in_progress" })],
      }),
    );
    expect(updates).toContainEqual(
      expect.objectContaining({ sessionUpdate: "tool_call", title: "Subagent: Explorer" }),
    );
    expect(updates).toContainEqual(
      expect.objectContaining({ sessionUpdate: "tool_call_update", toolCallId: "subagent-a1" }),
    );
    expect(response._meta).toMatchObject({ freebuff: { contextTokens: 1234 } });
  });

  it("tells the user when a locked slot ran a different model than requested", async () => {
    const conn = makeConn();
    const agent = new FreebuffAcpAgent(conn, testEnv());
    fetchMock.mockImplementation(async (url: string | URL | Request) =>
      hrefOf(url).includes("/session/admission")
        ? new Response("{}", { status: 500 })
        : new Response(
            JSON.stringify({ status: "active", instanceId: "held", model: "z-ai/glm-5.2" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
    );
    stubClient(agent, makeClient({ type: "success" }));
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);
    expect(JSON.stringify(conn.sessionUpdate.mock.calls)).toContain("locked to z-ai/glm-5.2");
    expect(loadPersistedSession(session.sessionId, testEnv())?.modelId).toBe("z-ai/glm-5.2");
  });

  it("returns cancelled for a queued turn cancelled before its lane slot, issuing no admission request", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), testEnv());

    const pending: Array<() => void> = [];
    const client = {
      run: vi.fn(async () => {
        const gate = Promise.withResolvers<{
          sessionState: { marker: number };
          output: { type: string };
        }>();
        function release() {
          gate.resolve({ sessionState: { marker: 1 }, output: { type: "success" } });
        }
        pending.push(release);
        return gate.promise;
      }),
    };
    stubClient(agent, client as unknown as ReturnType<typeof makeClient>);

    const session1 = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    const session2 = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);

    const p1 = agent.prompt({
      sessionId: session1.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);
    await vi.waitFor(() => expect(client.run).toHaveBeenCalledTimes(1));

    const p2 = agent.prompt({
      sessionId: session2.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);
    await agent.cancel({ sessionId: session2.sessionId });

    pending[0]?.();
    await p1;
    const response2 = await p2;

    expect(response2.stopReason).toBe("cancelled");
    // Cancelled while queued: runTurn (and its admission POST) never ran.
    expect(client.run).toHaveBeenCalledTimes(1);
    const admissionCalls = fetchMock.mock.calls.filter(([url]) => {
      const href = hrefOf(url);
      return href.includes("/session/admission");
    });
    expect(admissionCalls).toHaveLength(1);
  });

  it("hard-fails on an admitted model with no matching root agent, releasing a POST-claimed slot", async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const href = hrefOf(url);
      if (href.includes("/session/admission")) {
        return new Response(
          JSON.stringify({
            status: "active",
            instanceId: "inst-unknown",
            model: "some-vendor/unmapped-model",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ status: "none" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const conn = makeConn();
    const agent = new FreebuffAcpAgent(conn, testEnv());
    const client = makeClient({ type: "success" });
    stubClient(agent, client);

    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);

    expect(response.stopReason).toBe("refusal");
    expect(client.run).not.toHaveBeenCalled();
    const textUpdate = conn.sessionUpdate.mock.calls
      .map(
        ([params]) => params as { update: { sessionUpdate: string; content?: { text?: string } } },
      )
      .find((params) => params.update.sessionUpdate === "agent_message_chunk");
    expect(textUpdate?.update.content?.text).toContain("some-vendor/unmapped-model");

    // A slot this turn POST-claimed (reused: false) must still be released.
    const deleteCalls = fetchMock.mock.calls.filter(([, init]) => {
      const opts = init as RequestInit | undefined;
      return typeof opts?.method === "string" && opts.method.toUpperCase() === "DELETE";
    });
    expect(deleteCalls).toHaveLength(1);
  });

  it("hard-fails on an unknown model from a reused open slot without releasing it", async () => {
    fetchMock.mockImplementation(async (url: string | URL | Request) => {
      const href = hrefOf(url);
      if (href.includes("/session/admission")) {
        // Reusing an open slot never POSTs; hitting this would be a bug.
        return new Response(JSON.stringify({ status: "model_locked" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          status: "active",
          instanceId: "inst-open-unknown",
          model: "some-vendor/unmapped-model",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const conn = makeConn();
    const agent = new FreebuffAcpAgent(conn, testEnv());
    const client = makeClient({ type: "success" });
    stubClient(agent, client);

    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    const response = await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);

    expect(response.stopReason).toBe("refusal");
    expect(client.run).not.toHaveBeenCalled();
    // Never held this slot (reused: true) — must not be released.
    const mutating = fetchMock.mock.calls.filter(([, init]) => {
      const opts = init as RequestInit | undefined;
      const method = typeof opts?.method === "string" ? opts.method.toUpperCase() : "GET";
      return method === "POST" || method === "DELETE";
    });
    expect(mutating).toHaveLength(0);
    // Reuse never consults the open-session confirm — no permission prompt.
    expect(conn.requestPermission).not.toHaveBeenCalled();
  });

  it("writes persisted session files with 0600 permissions", () => {
    const env = testEnv();
    savePersistedSession(
      {
        sessionId: "freebuff-perm-1",
        cwd: "/tmp",
        modeId: "lite",
        runState: null,
        updatedAt: new Date().toISOString(),
      },
      env,
    );
    const file = path.join(stateDir, "freebuff-perm-1.json");
    const stat = fs.statSync(file);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("wires FREEBUFF_MODEL into the admission request", async () => {
    const agent = new FreebuffAcpAgent(makeConn(), testEnv({ FREEBUFF_MODEL: "mimo/mimo-v2.5" }));
    stubClient(agent, makeClient({ type: "success" }));

    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    await agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    } as never);

    const admissionCall = fetchMock.mock.calls.find(([url]) => {
      const href = hrefOf(url);
      return href.includes("/session/admission");
    });
    expect(admissionCall).toBeDefined();
    const init = admissionCall?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["x-freebuff-model"]).toBe("mimo/mimo-v2.5");
  });
});

describe("account, quota and session-open switch", () => {
  function statusResponse() {
    return new Response(
      JSON.stringify({
        status: "none",
        freebucks: {
          daily: { limit: 25, spent: 5, remaining: 20 },
          wallet: { balance: 0 },
          prices: { "z-ai/glm-5.3-flash": 5, "stealth/space-bunny-alpha": 0 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  it("shows the account and remaining quota, and prices on the models", async () => {
    fetchMock.mockImplementation(async () => statusResponse());
    const agent = new FreebuffAcpAgent(makeConn(), testEnv());
    stubClient(agent, makeClient({ type: "success" }));
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    const account = session.configOptions?.find((option) => option.id === "account");
    expect(account).toMatchObject({ type: "select" });
    expect(JSON.stringify(account)).toContain("20/25 Freebucks left today");
    const bunny = session.models?.availableModels.find(
      (model) => model.modelId === "stealth/space-bunny-alpha",
    );
    expect(bunny?.name).toBe("Space Bunny Alpha");
    expect(bunny?.description).toContain("Free");
    const glm = session.models?.availableModels.find(
      (model) => model.modelId === "z-ai/glm-5.3-flash",
    );
    expect(glm?.description).toContain("5 Freebucks/hour");
  });

  it("toggles session-open confirmation and persists it", async () => {
    fetchMock.mockImplementation(async () => statusResponse());
    const agent = new FreebuffAcpAgent(makeConn(), testEnv());
    stubClient(agent, makeClient({ type: "success" }));
    const session = await agent.newSession({ cwd: "/tmp", mcpServers: [] } as never);
    const response = await agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "confirm_open",
      value: "auto",
    } as never);
    const option = response.configOptions.find((entry) => entry.id === "confirm_open");
    expect(option?.currentValue).toBe("auto");
    expect(loadPersistedSession(session.sessionId, testEnv())?.confirmOpen).toBe("auto");
    await expect(
      agent.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: "confirm_open",
        value: "bogus",
      } as never),
    ).rejects.toThrow(/Unknown session-open mode/);
  });
});
