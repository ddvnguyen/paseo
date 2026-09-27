/**
 * Ordering and retry contract for the chip row.
 *
 * Three defects are pinned here:
 * - QC round 8, a fresh create: `agent.session_open` is pre-commit, so writing
 *   there failed with "Unknown agent" and the row was lost forever.
 * - QC round 9, model/mode em dashes: those fields attach to the agent record
 *   after `agent.created`, so a snapshot read at flush time returned nothing.
 * - QC round 9, resume: the agent is in the store but not yet live, so the inline
 *   write was rejected. No event signals "now live", so this one retries.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import {
  ChipQueue,
  type ChipSink,
  type ProbeResult,
  type RetryPolicy,
  type StagedChip,
} from "./chip-queue.js";
import type { CtxInjectChipData } from "../shared/ctx-schema.js";
import { buildChipData } from "./ctx-capture.js";

const CWD = "/projects/shop";
const PROVIDER = "claude";
const MODEL = "space-bunny-free";
const MODE = "auto";

const ROW: CtxInjectChipData = {
  systemPromptInjected: false,
  systemPromptLength: 0,
  systemPromptHash: null,
  mcpServers: [],
  paseoToolsInjected: null,
  model: MODEL,
  modeId: MODE,
  reason: "create",
  capturedAt: "2026-09-27T00:00:00.000Z",
};

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: PROVIDER,
    cwd: CWD,
    model: MODEL,
    modeId: MODE,
    ...overrides,
  } as unknown as AgentSessionConfig;
}

/** Instant sleep so retry tests do not really wait. */
const noSleep = () => Promise.resolve();
const FAST_RETRY: RetryPolicy = { attempts: 4, backoffMs: [1, 1, 1] };

interface Recorder {
  sink: ChipSink;
  appends: Array<{ agentId: string; data: CtxInjectChipData }>;
  errors: Array<{ agentId: string; stage: string }>;
  built: StagedChip[];
  controlsSeen: Array<ProbeResult["controls"]>;
  /** Probe results, consumed one per call; the last repeats when exhausted. */
  probes: ProbeResult[];
}

function recorder(overrides: Partial<ChipSink> = {}, probes?: ProbeResult[]): Recorder {
  const appends: Recorder["appends"] = [];
  const errors: Recorder["errors"] = [];
  const built: StagedChip[] = [];
  const controlsSeen: Recorder["controlsSeen"] = [];
  const live: ProbeResult = {
    live: true,
    controls: { model: "live-model", currentModeId: "live-mode" },
  };
  const queue = [...(probes ?? [])];

  const sink: ChipSink = {
    probe: async () => {
      const next = queue.shift();
      const result = next ?? live;
      controlsSeen.push(result.controls);
      return result;
    },
    buildData: async (staged, controls) => {
      built.push(staged);
      // The real function, not a re-implementation: a local copy of the
      // precedence would make the model/mode assertions tautological.
      return buildChipData({
        facts: staged.facts,
        snapshot: controls,
        paseoToolsInjected: null,
        reason: staged.reason,
        capturedAt: ROW.capturedAt,
      });
    },
    append: async (agentId, data) => {
      appends.push({ agentId, data });
    },
    onError: (agentId, stage) => {
      errors.push({ agentId, stage });
    },
    ...overrides,
  };
  return { sink, appends, errors, built, controlsSeen, probes: queue };
}

function open(
  queue: ChipQueue,
  sink: ChipSink,
  overrides: Partial<{ agentId: string; reason: string; provider: string; cwd: string }> = {},
) {
  return queue.handleSessionOpen(
    {
      agentId: overrides.agentId ?? "a1",
      provider: overrides.provider ?? PROVIDER,
      cwd: overrides.cwd ?? CWD,
      reason: overrides.reason ?? "create",
      purpose: "interactive",
    },
    sink,
  );
}

function newQueue(): ChipQueue {
  return new ChipQueue(FAST_RETRY, noSleep);
}

describe("ChipQueue ordering (QC round 8 regression)", () => {
  it("does NOT write the row at session-open time for a create", async () => {
    const queue = newQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, CWD, createConfig());

    await open(queue, rec.sink);

    // The agent does not exist in agent-manager yet. Writing here is what
    // produced "Unknown agent" and a permanently missing chip.
    expect(rec.appends).toHaveLength(0);
    expect(queue.stagedCount).toBe(1);
  });

  it("writes the row from the post-commit agent.created signal", async () => {
    const queue = newQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, CWD, createConfig());
    await open(queue, rec.sink);

    await queue.handleAgentCreated("a1", rec.sink);

    expect(rec.appends).toHaveLength(1);
    expect(rec.appends[0].agentId).toBe("a1");
    expect(queue.stagedCount).toBe(0);
  });

  it("ignores an agent.created for an agent with nothing staged", async () => {
    const queue = newQueue();
    const rec = recorder();

    await queue.handleAgentCreated("unrelated", rec.sink);

    expect(rec.appends).toHaveLength(0);
    expect(rec.errors).toHaveLength(0);
  });

  it("flushes each staged row once", async () => {
    const queue = newQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, CWD, createConfig());
    await open(queue, rec.sink);

    await queue.handleAgentCreated("a1", rec.sink);
    await queue.handleAgentCreated("a1", rec.sink);

    expect(rec.appends).toHaveLength(1);
  });
});

describe("ChipQueue model and mode (QC round 9 defect)", () => {
  // The round-9 failure: a snapshot read at agent.created, before model/mode
  // attach to the record, left both as em dashes.
  it("carries the configured model and mode into the flushed row", async () => {
    const queue = newQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, CWD, createConfig({ model: MODEL, modeId: MODE }));
    await open(queue, rec.sink);

    await queue.handleAgentCreated("a1", rec.sink);

    const written = rec.appends[0].data;
    expect(written.model).toBe(MODEL);
    expect(written.modeId).toBe(MODE);
    // Not the em dash round 9 produced.
    expect(written.model).not.toBeNull();
    expect(written.modeId).not.toBeNull();
  });

  it("does not depend on the snapshot for a create", async () => {
    const queue = newQueue();
    // Agent never reports controls, exactly like the round-9 race.
    const rec = recorder({}, [{ live: true, controls: null }]);
    queue.captureCreate(PROVIDER, CWD, createConfig());
    await open(queue, rec.sink);

    await queue.handleAgentCreated("a1", rec.sink);

    expect(rec.appends[0].data.model).toBe(MODEL);
    expect(rec.appends[0].data.modeId).toBe(MODE);
  });

  it("falls back to the live snapshot when no create hook was correlated", async () => {
    const queue = newQueue();
    const rec = recorder();

    await open(queue, rec.sink, { reason: "resume", agentId: "a9" });

    expect(rec.appends[0].data.model).toBe("live-model");
    expect(rec.appends[0].data.modeId).toBe("live-mode");
  });
});

describe("ChipQueue retry on a not-yet-live agent (QC round 9 defect)", () => {
  it("recovers when the append is rejected until the agent exists", async () => {
    const queue = newQueue();
    // The override replaces the recorder's own append, so count successes here.
    const landed: string[] = [];
    let calls = 0;
    const append = vi.fn(async (agentId: string) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("Request failed: Unknown agent 'a9' code=handler_error");
      }
      landed.push(agentId);
    });
    const rec = recorder({ append });

    await open(queue, rec.sink, { reason: "resume", agentId: "a9" });

    expect(append).toHaveBeenCalledTimes(2);
    expect(landed).toEqual(["a9"]);
    expect(rec.errors).toHaveLength(0);
  });

  it("waits and re-probes while the agent is not live yet", async () => {
    const queue = newQueue();
    const rec = recorder({}, [
      { live: false, controls: null },
      { live: false, controls: null },
      { live: true, controls: { model: "live-model", currentModeId: "live-mode" } },
    ]);

    await open(queue, rec.sink, { reason: "refresh", agentId: "a9" });

    expect(rec.appends).toHaveLength(1);
    // The snapshot is only read once the agent is live, so the row is not a
    // wall of em dashes from a premature read.
    expect(rec.controlsSeen).toEqual([
      null,
      null,
      { model: "live-model", currentModeId: "live-mode" },
    ]);
  });

  it("gives up loudly once the retry budget is spent", async () => {
    const queue = newQueue();
    const append = vi
      .fn<(agentId: string, data: CtxInjectChipData) => Promise<void>>()
      .mockRejectedValue(new Error("Unknown agent 'a9'"));
    const rec = recorder({ append });

    await open(queue, rec.sink, { reason: "resume", agentId: "a9" });

    expect(append).toHaveBeenCalledTimes(FAST_RETRY.attempts);
    expect(rec.appends).toHaveLength(0);
    // The row is lost, but never silently.
    expect(rec.errors).toEqual([{ agentId: "a9", stage: "append" }]);
  });

  it("reports not-live when the agent never comes up", async () => {
    const queue = newQueue();
    const notLive = { live: false, controls: null };
    const rec = recorder({}, [notLive, notLive, notLive, notLive]);

    await open(queue, rec.sink, { reason: "resume", agentId: "a9" });

    expect(rec.appends).toHaveLength(0);
    expect(rec.errors).toEqual([{ agentId: "a9", stage: "not-live" }]);
  });

  it("does not retry an error that is not about agent availability", async () => {
    const queue = newQueue();
    const append = vi
      .fn<(agentId: string, data: CtxInjectChipData) => Promise<void>>()
      .mockRejectedValue(new Error("payload exceeds 64 KiB"));
    const rec = recorder({ append });

    await open(queue, rec.sink, { reason: "resume", agentId: "a9" });

    // Retrying a schema fault would only delay the report.
    expect(append).toHaveBeenCalledTimes(1);
    expect(rec.errors).toEqual([{ agentId: "a9", stage: "append" }]);
  });

  it("reports a build failure without attempting the append", async () => {
    const queue = newQueue();
    const append = vi.fn<(agentId: string, data: CtxInjectChipData) => Promise<void>>();
    const rec = recorder({
      append,
      buildData: async () => {
        throw new Error("config read exploded");
      },
    });
    queue.captureCreate(PROVIDER, CWD, createConfig());
    await open(queue, rec.sink);
    await queue.handleAgentCreated("a1", rec.sink);

    expect(append).not.toHaveBeenCalled();
    expect(rec.errors).toEqual([{ agentId: "a1", stage: "build" }]);
  });
});

describe("ChipQueue non-create reasons", () => {
  // A resumed agent is already in the store, so it must not wait for an
  // agent.created that will never fire for it.
  it.each(["resume", "refresh", "import"])("writes inline on %s", async (reason) => {
    const queue = newQueue();
    const rec = recorder();

    await open(queue, rec.sink, { reason, agentId: "a2" });

    expect(rec.appends).toHaveLength(1);
    expect(rec.appends[0].data.reason).toBe(reason);
    expect(queue.stagedCount).toBe(0);
  });
});

describe("ChipQueue correlation", () => {
  it("keeps concurrent creates of different providers separate", async () => {
    const queue = newQueue();
    const rec = recorder();
    const claudePrompt = "claude prompt";
    queue.captureCreate("claude", "/a", createConfig({ systemPrompt: claudePrompt }));
    queue.captureCreate(
      "codex",
      "/b",
      createConfig({
        provider: "codex",
        cwd: "/b",
        systemPrompt: "codex prompt is longer",
      }) as never,
    );

    await open(queue, rec.sink, { agentId: "claude-agent", provider: "claude", cwd: "/a" });
    await queue.handleAgentCreated("claude-agent", rec.sink);

    // The codex facts must not leak into the claude agent's row.
    expect(rec.built[0].facts?.systemPromptLength).toBe(claudePrompt.length);
  });

  it("drops a create fact that never found a session open", async () => {
    const queue = newQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, "/stale", createConfig({ cwd: "/stale" }));

    // Different cwd: no bucket match, so nothing is bound and the row is unknown.
    await open(queue, rec.sink, { agentId: "a3", cwd: "/elsewhere" });
    await queue.handleAgentCreated("a3", rec.sink);

    expect(rec.appends).toHaveLength(1);
    expect(rec.built[0].facts).toBeNull();
  });

  it("clear() drops all state", () => {
    const queue = newQueue();
    queue.captureCreate(PROVIDER, CWD, createConfig());
    queue.clear();

    expect(queue.stagedCount).toBe(0);
  });
});
