import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { createAgentSessionIdleService } from "./agent-session-idle-service.js";

const AGENT_ID = "agent-1";
const IDLE_TIMEOUT_MS = 30 * 60_000;

function makeAgent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: AGENT_ID,
    cwd: "/repo/ws1",
    provider: "opencode",
    lifecycle: "idle",
    activeForegroundTurnId: null,
    ...overrides,
  } as unknown as ManagedAgent;
}

interface DemoteHarness {
  demoted: string[];
  agents: Map<string, ManagedAgent>;
  agentManager: Pick<AgentManager, "getAgent" | "demoteIdleAgentToCold">;
}

function buildHarness(): DemoteHarness {
  const demoted: string[] = [];
  const agents = new Map<string, ManagedAgent>([[AGENT_ID, makeAgent()]]);

  const agentManager = {
    getAgent: (id: string) => agents.get(id) ?? null,
    demoteIdleAgentToCold: async (id: string) => {
      demoted.push(id);
      agents.delete(id);
      return true;
    },
  } as unknown as Pick<AgentManager, "getAgent" | "demoteIdleAgentToCold">;

  return { demoted, agents, agentManager };
}

describe("createAgentSessionIdleService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("demotes an idle agent once the timeout expires", async () => {
    const harness = buildHarness();
    const service = createAgentSessionIdleService({
      agentManager: harness.agentManager,
      timeoutMs: IDLE_TIMEOUT_MS,
      logger: createTestLogger(),
    });

    service.handleAgentEvent({ type: "agent_state", agent: makeAgent({ lifecycle: "idle" }) });
    expect(harness.demoted).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(harness.demoted).toEqual([AGENT_ID]);

    service.dispose();
  });

  test("activity (turn_started) re-arms the timer so a busy agent is not reaped", async () => {
    const harness = buildHarness();
    const service = createAgentSessionIdleService({
      agentManager: harness.agentManager,
      timeoutMs: IDLE_TIMEOUT_MS,
      logger: createTestLogger(),
    });

    service.handleAgentEvent({ type: "agent_state", agent: makeAgent({ lifecycle: "idle" }) });
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS / 2);
    expect(harness.demoted).toHaveLength(0);

    // A turn starts: the lease re-arms for a full timeout again.
    service.handleAgentEvent({
      type: "agent_stream",
      agentId: AGENT_ID,
      event: { type: "turn_started", provider: "opencode", turnId: "t1" },
    });
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS / 2);
    expect(harness.demoted).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(harness.demoted).toEqual([AGENT_ID]);

    service.dispose();
  });

  test("does not demote an agent a viewer is looking at", async () => {
    const harness = buildHarness();
    const service = createAgentSessionIdleService({
      agentManager: harness.agentManager,
      timeoutMs: IDLE_TIMEOUT_MS,
      logger: createTestLogger(),
    });
    service.setViewerChecker(() => true);

    service.handleAgentEvent({ type: "agent_state", agent: makeAgent({ lifecycle: "idle" }) });
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2);
    expect(harness.demoted).toHaveLength(0);

    service.dispose();
  });

  test("reaps a viewed agent once the viewer leaves (re-arms while viewed)", async () => {
    const harness = buildHarness();
    const service = createAgentSessionIdleService({
      agentManager: harness.agentManager,
      timeoutMs: IDLE_TIMEOUT_MS,
      logger: createTestLogger(),
    });
    let viewing = true;
    service.setViewerChecker(() => viewing);

    service.handleAgentEvent({ type: "agent_state", agent: makeAgent({ lifecycle: "idle" }) });

    // First expiry is skipped because the viewer is present, but the lease re-arms.
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(harness.demoted).toHaveLength(0);

    // Viewer leaves; the next expiry reaps.
    viewing = false;
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(harness.demoted).toEqual([AGENT_ID]);

    service.dispose();
  });

  test("skips already-cold agents", async () => {
    const harness = buildHarness();
    const service = createAgentSessionIdleService({
      agentManager: harness.agentManager,
      timeoutMs: IDLE_TIMEOUT_MS,
      logger: createTestLogger(),
    });

    service.handleAgentEvent({
      type: "agent_state",
      agent: makeAgent({ lifecycle: "idle", cold: true }),
    });
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2);
    expect(harness.demoted).toHaveLength(0);

    service.dispose();
  });

  test("skips a running agent at expiry", async () => {
    const harness = buildHarness();
    harness.agents.set(AGENT_ID, makeAgent({ lifecycle: "running" }));
    const service = createAgentSessionIdleService({
      agentManager: harness.agentManager,
      timeoutMs: IDLE_TIMEOUT_MS,
      logger: createTestLogger(),
    });

    // Lease armed while idle, then the agent starts a turn before expiry.
    service.handleAgentEvent({ type: "agent_state", agent: makeAgent({ lifecycle: "idle" }) });
    harness.agents.set(AGENT_ID, makeAgent({ lifecycle: "running", activeForegroundTurnId: "t1" }));

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2);
    expect(harness.demoted).toHaveLength(0);

    service.dispose();
  });

  test("is disabled when timeoutMs is 0", async () => {
    const harness = buildHarness();
    const service = createAgentSessionIdleService({
      agentManager: harness.agentManager,
      timeoutMs: 0,
      logger: createTestLogger(),
    });

    service.handleAgentEvent({ type: "agent_state", agent: makeAgent({ lifecycle: "idle" }) });
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2);
    expect(harness.demoted).toHaveLength(0);

    service.dispose();
  });
});
