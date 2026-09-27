/**
 * Ordering contract for the chip row.
 *
 * QC round 8 caught the row never appearing on a fresh agent: `agent.session_open`
 * fires before the daemon commits the agent, so `timeline.append` failed with
 * "Unknown agent" and the failure was swallowed. The first test below is the
 * regression guard for exactly that.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { ChipQueue, type ChipSink, type StagedChip } from "./chip-queue.js";
import type { CtxInjectChipData } from "../shared/ctx-schema.js";

const CWD = "/projects/shop";
const PROVIDER = "claude";

const FACTS: CtxInjectChipData = {
  systemPromptInjected: true,
  systemPromptLength: 40,
  systemPromptHash: "abcdef012345",
  mcpServers: ["github"],
  paseoToolsInjected: true,
  model: "claude-opus-5",
  modeId: "plan",
  reason: "create",
  capturedAt: "2026-09-27T00:00:00.000Z",
};

function createConfig(systemPrompt = "you are a helpful assistant"): AgentSessionConfig {
  return {
    provider: PROVIDER,
    cwd: CWD,
    systemPrompt,
    mcpServers: { github: {} },
  } as unknown as AgentSessionConfig;
}

interface Recorder {
  sink: ChipSink;
  appends: Array<{ agentId: string; data: CtxInjectChipData }>;
  errors: Array<{ agentId: string; stage: string }>;
  built: StagedChip[];
}

function recorder(overrides: Partial<ChipSink> = {}): Recorder {
  const appends: Recorder["appends"] = [];
  const errors: Recorder["errors"] = [];
  const built: StagedChip[] = [];
  const sink: ChipSink = {
    buildData: async (staged) => {
      built.push(staged);
      return { ...FACTS, reason: staged.reason };
    },
    append: async (agentId, data) => {
      appends.push({ agentId, data });
    },
    onError: (agentId, stage) => {
      errors.push({ agentId, stage });
    },
    ...overrides,
  };
  return { sink, appends, errors, built };
}

function openCreate(queue: ChipQueue, sink: ChipSink, agentId = "a1") {
  return queue.handleSessionOpen(
    { agentId, provider: PROVIDER, cwd: CWD, reason: "create", purpose: "interactive" },
    sink,
  );
}

describe("ChipQueue ordering (QC round 8 regression)", () => {
  it("does NOT write the row at session-open time for a create", async () => {
    const queue = new ChipQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, CWD, createConfig());

    await openCreate(queue, rec.sink);

    // The agent does not exist in agent-manager yet. Writing here is what
    // produced "Unknown agent" and a permanently missing chip.
    expect(rec.appends).toHaveLength(0);
    expect(queue.stagedCount).toBe(1);
  });

  it("writes the row from the post-commit agent.created signal", async () => {
    const queue = new ChipQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, CWD, createConfig());
    await openCreate(queue, rec.sink);

    await queue.handleAgentCreated("a1", rec.sink);

    expect(rec.appends).toHaveLength(1);
    expect(rec.appends[0].agentId).toBe("a1");
    expect(queue.stagedCount).toBe(0);
  });

  it("carries the correlated create facts into the flushed row", async () => {
    const queue = new ChipQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, CWD, createConfig());
    await openCreate(queue, rec.sink);
    await queue.handleAgentCreated("a1", rec.sink);

    const staged = rec.built[0];
    expect(staged.facts).toMatchObject({ systemPromptInjected: true, mcpServers: ["github"] });
  });

  it("ignores an agent.created for an agent with nothing staged", async () => {
    const queue = new ChipQueue();
    const rec = recorder();

    await queue.handleAgentCreated("unrelated", rec.sink);

    expect(rec.appends).toHaveLength(0);
    expect(rec.errors).toHaveLength(0);
  });

  it("flushes each staged row once", async () => {
    const queue = new ChipQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, CWD, createConfig());
    await openCreate(queue, rec.sink);

    await queue.handleAgentCreated("a1", rec.sink);
    await queue.handleAgentCreated("a1", rec.sink);

    expect(rec.appends).toHaveLength(1);
  });
});

describe("ChipQueue non-create reasons", () => {
  // A resumed agent is already committed, so it must not wait for an
  // agent.created that will never fire for it.
  it.each(["resume", "refresh", "import"])("writes immediately on %s", async (reason) => {
    const queue = new ChipQueue();
    const rec = recorder();

    await queue.handleSessionOpen(
      { agentId: "a2", provider: PROVIDER, cwd: CWD, reason, purpose: "interactive" },
      rec.sink,
    );

    expect(rec.appends).toHaveLength(1);
    expect(rec.appends[0].data.reason).toBe(reason);
    expect(queue.stagedCount).toBe(0);
  });
});

describe("ChipQueue failure reporting", () => {
  it("reports an append rejection instead of swallowing it", async () => {
    const queue = new ChipQueue();
    const append = vi.fn(async () => {
      throw new Error("Unknown agent 'a1'");
    });
    const rec = recorder({ append });
    queue.captureCreate(PROVIDER, CWD, createConfig());
    await openCreate(queue, rec.sink);
    await queue.handleAgentCreated("a1", rec.sink);

    expect(append).toHaveBeenCalledTimes(1);
    // QC's complaint was a silent swallow: the row vanished with no signal.
    expect(rec.errors).toEqual([{ agentId: "a1", stage: "append" }]);
  });

  it("reports a build failure without attempting the append", async () => {
    const queue = new ChipQueue();
    const append = vi.fn(async () => undefined);
    const rec = recorder({
      append,
      buildData: async () => {
        throw new Error("config read exploded");
      },
    });
    queue.captureCreate(PROVIDER, CWD, createConfig());
    await openCreate(queue, rec.sink);
    await queue.handleAgentCreated("a1", rec.sink);

    expect(append).not.toHaveBeenCalled();
    expect(rec.errors).toEqual([{ agentId: "a1", stage: "build" }]);
  });
});

describe("ChipQueue correlation", () => {
  it("keeps concurrent creates of different providers separate", async () => {
    const queue = new ChipQueue();
    const rec = recorder();
    const claudePrompt = "claude prompt";
    const codexPrompt = "codex prompt is a different length";
    queue.captureCreate("claude", "/a", createConfig(claudePrompt));
    queue.captureCreate("codex", "/b", createConfig(codexPrompt) as never);

    await queue.handleSessionOpen(
      {
        agentId: "claude-agent",
        provider: "claude",
        cwd: "/a",
        reason: "create",
        purpose: "interactive",
      },
      rec.sink,
    );
    await queue.handleAgentCreated("claude-agent", rec.sink);

    // The codex facts must not leak into the claude agent's row.
    expect(rec.built[0].facts?.systemPromptLength).toBe(claudePrompt.length);
  });

  it("drops a create fact that never found a session open", async () => {
    const queue = new ChipQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, "/stale", createConfig());

    // Different cwd: no bucket match, so nothing is bound and the row is unknown.
    await queue.handleSessionOpen(
      {
        agentId: "a3",
        provider: PROVIDER,
        cwd: "/elsewhere",
        reason: "create",
        purpose: "history",
      },
      rec.sink,
    );
    await queue.handleAgentCreated("a3", rec.sink);

    expect(rec.appends).toHaveLength(1);
    expect(rec.built[0].facts).toBeNull();
  });

  it("clear() drops all state", () => {
    const queue = new ChipQueue();
    queue.captureCreate(PROVIDER, CWD, createConfig());
    queue.clear();

    expect(queue.stagedCount).toBe(0);
  });
});
