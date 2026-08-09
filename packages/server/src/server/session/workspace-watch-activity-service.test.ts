import { describe, expect, test } from "vitest";
import type { AgentManager, ManagedAgent } from "../../agent/agent-manager.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import { createWorkspaceWatchActivityService } from "./workspace-watch-activity-service.js";

const AGENT_ID = "agent-1";
const CWD = "/repo/ws1";

function makeAgent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: AGENT_ID,
    cwd: CWD,
    lifecycle: "idle",
    activeForegroundTurnId: null,
    ...overrides,
  } as unknown as ManagedAgent;
}

function buildHarness() {
  const touched: string[] = [];
  const agents = new Map<string, ManagedAgent>([[AGENT_ID, makeAgent()]]);

  const agentManager = {
    getAgent: (id: string) => agents.get(id) ?? null,
    listAgents: () => Array.from(agents.values()),
  } as unknown as AgentManager;

  const workspaceGitService = {
    touchWorkspaceWatch: (cwd: string) => {
      touched.push(cwd);
    },
  } as unknown as WorkspaceGitService;

  return {
    touched,
    agents,
    agentManager,
    workspaceGitService,
  };
}

describe("createWorkspaceWatchActivityService", () => {
  test("touches the workspace when an agent runs", () => {
    const harness = buildHarness();
    const service = createWorkspaceWatchActivityService({
      agentManager: harness.agentManager,
      workspaceGitService: harness.workspaceGitService,
    });

    service.handleAgentEvent({ type: "agent_state", agent: makeAgent({ lifecycle: "running" }) });
    expect(harness.touched).toContain(CWD);

    service.dispose();
  });

  test("touches the workspace when a foreground turn is active", () => {
    const harness = buildHarness();
    const service = createWorkspaceWatchActivityService({
      agentManager: harness.agentManager,
      workspaceGitService: harness.workspaceGitService,
    });

    service.handleAgentEvent({
      type: "agent_state",
      agent: makeAgent({ lifecycle: "running", activeForegroundTurnId: "turn-1" }),
    });
    expect(harness.touched).toContain(CWD);

    service.dispose();
  });

  test("does not touch for idle agents with no active turn", () => {
    const harness = buildHarness();
    const service = createWorkspaceWatchActivityService({
      agentManager: harness.agentManager,
      workspaceGitService: harness.workspaceGitService,
    });

    service.handleAgentEvent({ type: "agent_state", agent: makeAgent({ lifecycle: "idle" }) });
    expect(harness.touched).toEqual([]);

    service.dispose();
  });

  test("touches the workspace when a turn starts", () => {
    const harness = buildHarness();
    const service = createWorkspaceWatchActivityService({
      agentManager: harness.agentManager,
      workspaceGitService: harness.workspaceGitService,
    });

    service.handleAgentEvent({
      type: "agent_stream",
      agentId: AGENT_ID,
      event: { type: "turn_started", provider: "claude" },
    });
    expect(harness.touched).toContain(CWD);

    service.dispose();
  });

  test("touchCwd declares interest for a client viewing a workspace", () => {
    const harness = buildHarness();
    const service = createWorkspaceWatchActivityService({
      agentManager: harness.agentManager,
      workspaceGitService: harness.workspaceGitService,
    });

    service.touchCwd("/repo/ws2");
    expect(harness.touched).toContain("/repo/ws2");

    service.dispose();
  });
});
