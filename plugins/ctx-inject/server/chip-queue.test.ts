/**
 * Ordering and retry contract for the chip row.
 *
 * Four defects are pinned here, and the last one is the most important because it
 * was a regression this file's earlier revisions would have accepted:
 * - QC round 8, a fresh create: `agent.session_open` is pre-commit, so the write
 *   there failed with "Unknown agent" and the row was lost.
 * - QC round 9, model/mode em dashes: those attach to the agent record only at a
 *   later revision, after `agent.created`.
 * - QC round 9, resume: the agent is in the store but not yet committed.
 * - QC round 10, REGRESSION: the retry was gated behind a live session handle,
 *   which is strictly stronger than the map commit the append needs, so the append
 *   was never attempted and the chip disappeared.
 *
 * The invariant those add up to: the append is the action AND the proof. There is
 * no liveness gate in front of it.
 */

import { describe, expect, it } from "vitest";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import {
  ChipQueue,
  DEFAULT_RETRY,
  type ChipSink,
  type RetryPolicy,
  type SnapshotControls,
  type StagedChip,
} from "./chip-queue.js";
import type { CtxInjectChipData } from "../shared/ctx-schema.js";
import { buildChipData } from "./ctx-capture.js";

const CWD = "/projects/shop";
const PROVIDER = "claude";
const MODEL = "space-bunny-free";
const MODE = "auto";
const CAPTURED = "2026-09-27T00:00:00.000Z";

/** Instant sleep so retry tests do not really wait. */
const noSleep = () => Promise.resolve();
const FAST_RETRY: RetryPolicy = { attempts: 8, backoffMs: [1, 1, 1, 1, 1, 1, 1] };

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: PROVIDER,
    cwd: CWD,
    model: MODEL,
    modeId: MODE,
    ...overrides,
  } as unknown as AgentSessionConfig;
}

interface Recorder {
  sink: ChipSink;
  /** Every sink interaction, in order — the invariant is about this sequence. */
  calls: string[];
  appends: Array<{ agentId: string; data: CtxInjectChipData }>;
  errors: Array<{ agentId: string; stage: string }>;
  built: StagedChip[];
  controls: SnapshotControls | null;
}

interface RecorderOptions {
  /** Fails this many appends before any succeeds. Defaults to "all" with rejectWith. */
  rejectAppends?: number;
  /** Rejection message; providing it makes append fail unless rejectAppends is set. */
  rejectWith?: string;
  /** Controls the post-commit read returns. */
  controls?: SnapshotControls | null;
}

function recorder(options: RecorderOptions = {}): Recorder {
  const calls: string[] = [];
  const appends: Recorder["appends"] = [];
  const errors: Recorder["errors"] = [];
  const built: StagedChip[] = [];
  const controls: SnapshotControls | null =
    "controls" in options
      ? (options.controls ?? null)
      : { model: "live-model", currentModeId: "live-mode" };
  // `rejectWith` alone means "always reject"; an explicit count means the first N.
  let remaining = options.rejectAppends ?? (options.rejectWith ? Infinity : 0);

  const sink: ChipSink = {
    buildData: async (staged, snapshot) => {
      calls.push("build");
      built.push(staged);
      // The real function, not a re-implementation: a local copy of the
      // precedence would make the model/mode assertions tautological.
      return buildChipData({
        facts: staged.facts,
        snapshot,
        paseoToolsInjected: null,
        reason: staged.reason,
        capturedAt: CAPTURED,
      });
    },
    append: async (agentId, data) => {
      calls.push("append");
      if (remaining > 0) {
        remaining -= 1;
        throw new Error(
          options.rejectWith ?? `Request failed: Unknown agent '${agentId}' code=handler_error`,
        );
      }
      appends.push({ agentId, data });
    },
    readControls: () => {
      calls.push("readControls");
      return controls;
    },
    onError: (agentId, stage) => {
      calls.push("onError");
      errors.push({ agentId, stage });
    },
  };
  return { sink, calls, appends, errors, built, controls };
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

function newQueue(retry: RetryPolicy = FAST_RETRY): ChipQueue {
  return new ChipQueue(retry, noSleep);
}

describe("append-first invariant (QC round 10 regression)", () => {
  it("attempts the append before any other host call", async () => {
    const queue = newQueue();
    const rec = recorder();

    await open(queue, rec.sink, { reason: "resume", agentId: "a1" });

    // Round 10 lost the chip because a live-handle check ran first and never
    // passed. The write must be the first thing attempted, every time.
    expect(rec.calls[0]).toBe("build");
    expect(rec.calls[1]).toBe("append");
  });

  it("never consults agent liveness before the write", async () => {
    const queue = newQueue();
    const rec = recorder();

    await open(queue, rec.sink, { reason: "resume", agentId: "a1" });

    // The only permitted post-commit read, and only after an append landed.
    expect(rec.calls.filter((call) => call === "readControls")).toHaveLength(1);
    expect(rec.calls.indexOf("readControls")).toBeGreaterThan(0);
    expect(rec.calls.indexOf("readControls")).toBeGreaterThan(rec.calls.indexOf("append"));
  });

  it("does not read controls at all when the first write already has them", async () => {
    const queue = newQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, CWD, createConfig());
    await open(queue, rec.sink);
    await queue.handleAgentCreated("a1", rec.sink);

    // The create config already carries model/mode, so there is nothing to refine
    // and no reason to touch the agent record at all.
    expect(rec.calls).toEqual(["build", "append"]);
  });
});

describe("idle-agent resume (QC round 10)", () => {
  it("flushes after repeated not-committed rejections", async () => {
    const queue = newQueue();
    // An idle agent that needs several seconds to be committed. Controls are
    // withheld so this test asserts on the first write and nothing else.
    const rec = recorder({ rejectAppends: 5, controls: null });

    await open(queue, rec.sink, { reason: "resume", agentId: "a9" });

    expect(rec.appends).toHaveLength(1);
    expect(rec.errors).toHaveLength(0);
  });

  it("recovers within the shipped retry budget", () => {
    // Round 10 exhausted a ~1.7s budget. The shipped budget must outlive a slow
    // or 403-disabled provider setup, and the flush is fire-and-forget anyway.
    const total = DEFAULT_RETRY.backoffMs.reduce((sum, ms) => sum + ms, 0);
    expect(DEFAULT_RETRY.attempts).toBeGreaterThan(4);
    expect(total).toBeGreaterThan(5000);
  });
});

describe("ChipQueue ordering (QC round 8 regression)", () => {
  it("does NOT write the row at session-open time for a create", async () => {
    const queue = newQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, CWD, createConfig());

    await open(queue, rec.sink);

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

describe("model and mode", () => {
  // The round-9 failure: a record read at agent.created, before model/mode attach
  // at a later revision, left both as em dashes.
  it("carries the configured model and mode into the flushed row", async () => {
    const queue = newQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, CWD, createConfig({ model: MODEL, modeId: MODE }));
    await open(queue, rec.sink);

    await queue.handleAgentCreated("a1", rec.sink);

    expect(rec.appends[0].data.model).toBe(MODEL);
    expect(rec.appends[0].data.modeId).toBe(MODE);
  });

  it("refines a hookless session with controls read after the write", async () => {
    const queue = newQueue();
    const rec = recorder();

    await open(queue, rec.sink, { reason: "resume", agentId: "a9" });

    // First write carries no model/mode; the post-commit read supplies them and
    // the same row id is rewritten.
    expect(rec.calls).toEqual(["build", "append", "readControls", "build", "append"]);
    expect(rec.appends[0].data.model).toBeNull();
    expect(rec.appends.at(-1)?.data.model).toBe("live-model");
    expect(rec.appends.at(-1)?.data.modeId).toBe("live-mode");
  });

  it("does not rewrite when the refinement adds nothing", async () => {
    const queue = newQueue();
    const rec = recorder({ controls: null });

    await open(queue, rec.sink, { reason: "resume", agentId: "a9" });

    expect(rec.calls).toEqual(["build", "append", "readControls"]);
    expect(rec.appends).toHaveLength(1);
  });

  it("survives a controls read that throws", async () => {
    const queue = newQueue();
    const rec = recorder();
    rec.sink.readControls = () => {
      rec.calls.push("readControls");
      throw new Error("record read failed");
    };

    await open(queue, rec.sink, { reason: "resume", agentId: "a9" });

    // A failed refinement read is "unknown", not a chip failure.
    expect(rec.appends).toHaveLength(1);
    expect(rec.errors).toHaveLength(0);
  });
});

describe("retry on a not-yet-committed agent", () => {
  it("recovers when the append is rejected until the agent commits", async () => {
    const queue = newQueue();
    const rec = recorder({ rejectAppends: 1, controls: null });

    await open(queue, rec.sink, { reason: "resume", agentId: "a9" });

    expect(rec.calls.filter((c) => c === "append").length).toBeGreaterThanOrEqual(2);
    expect(rec.appends).toHaveLength(1);
    expect(rec.errors).toHaveLength(0);
  });

  it("gives up loudly once the retry budget is spent", async () => {
    const queue = newQueue({ attempts: 3, backoffMs: [1, 1] });
    const rec = recorder({ rejectWith: "Unknown agent 'a9'" });

    await open(queue, rec.sink, { reason: "resume", agentId: "a9" });

    // The row is lost, but never silently.
    expect(rec.errors).toEqual([{ agentId: "a9", stage: "append" }]);
  });

  it("does not retry an error that is not about agent availability", async () => {
    const queue = newQueue();
    const rec = recorder({ rejectWith: "payload exceeds 64 KiB" });

    await open(queue, rec.sink, { reason: "resume", agentId: "a9" });

    // Retrying a schema fault would only delay the report.
    expect(rec.calls.filter((c) => c === "append")).toHaveLength(1);
    expect(rec.errors).toEqual([{ agentId: "a9", stage: "append" }]);
  });

  it("reports a build failure without attempting the append", async () => {
    const queue = newQueue();
    const rec = recorder();
    rec.sink.buildData = async () => {
      rec.calls.push("build");
      throw new Error("config read exploded");
    };
    queue.captureCreate(PROVIDER, CWD, createConfig());
    await open(queue, rec.sink);
    await queue.handleAgentCreated("a1", rec.sink);

    expect(rec.calls).not.toContain("append");
    expect(rec.errors).toEqual([{ agentId: "a1", stage: "build" }]);
  });
});

describe("non-create reasons", () => {
  it.each(["resume", "refresh", "import"])("writes inline on %s", async (reason) => {
    const queue = newQueue();
    const rec = recorder({ controls: null });

    await open(queue, rec.sink, { reason, agentId: "a2" });

    expect(rec.appends).toHaveLength(1);
    expect(rec.appends[0].data.reason).toBe(reason);
    expect(queue.stagedCount).toBe(0);
  });
});

describe("correlation", () => {
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

    expect(rec.built[0].facts?.systemPromptLength).toBe(claudePrompt.length);
  });

  it("drops a create fact that never found a session open", async () => {
    const queue = newQueue();
    const rec = recorder();
    queue.captureCreate(PROVIDER, "/stale", createConfig({ cwd: "/stale" }));

    await open(queue, rec.sink, { agentId: "a3", cwd: "/elsewhere" });
    await queue.handleAgentCreated("a3", rec.sink);

    expect(rec.built[0].facts).toBeNull();
  });

  it("clear() drops all state", () => {
    const queue = newQueue();
    queue.captureCreate(PROVIDER, CWD, createConfig());
    queue.clear();

    expect(queue.stagedCount).toBe(0);
  });
});
