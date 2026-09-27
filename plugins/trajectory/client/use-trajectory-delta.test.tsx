/** Delta-loop hook tests: drain-then-park, error keeps rows, no timers. */

// @vitest-environment jsdom
// @ts-expect-error repo pattern: expose act() support flag before react loads
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrajectoryEvent } from "../shared/trajectory.js";
import { useTrajectoryDelta } from "./use-trajectory-delta.js";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

type RpcHandler = (input: never) => Promise<unknown>;
const rpcHandlers: { current: Record<string, RpcHandler> } = { current: {} };
// Stable per-contract fns: the hook keys its effect on the useRpc return
// identity (the real useRpc is useCallback-stable), so the mock must be too,
// or every render re-runs the effect into an infinite loop.
const rpcFns: { current: Record<string, (input: unknown) => Promise<unknown>> } = {
  current: {},
};

vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => {
    let fn = rpcFns.current[contract.name];
    if (!fn) {
      fn = (input: unknown) => rpcHandlers.current[contract.name]?.(input as never);
      rpcFns.current[contract.name] = fn;
    }
    return fn;
  },
}));

const BASE = Date.parse("2026-09-26T00:00:00Z");

function evt(
  seq: number,
  overrides: Partial<TrajectoryEvent> & Pick<TrajectoryEvent, "type">,
): TrajectoryEvent {
  return {
    seq,
    time: new Date(BASE + seq * 1_000).toISOString(),
    turn: "t1",
    step: null,
    agentId: "a1",
    data: {},
    ...overrides,
  };
}

const userMsg = (seq: number) => evt(seq, { type: "user/message", data: { textLength: 10 } });
const assistantMsg = (seq: number, step: number) =>
  evt(seq, { type: "assistant/message", step, data: { textLength: 20 } });
const toolCall = (seq: number, step: number) =>
  evt(seq, { type: "tool/call", step, data: { callId: "c1", name: "shell" } });
const toolResult = (seq: number, step: number) =>
  evt(seq, {
    type: "tool/result",
    step,
    data: { callId: "c1", name: "shell", durationMs: 400, outputChars: 12 },
  });

interface ProbeView {
  status: string;
  rows: number;
  headSeq: number;
  error?: string;
}

const probeRef: { current: ProbeView | null } = { current: null };

function Probe({ agentId }: { agentId: string }) {
  const delta = useTrajectoryDelta(agentId);
  probeRef.current = {
    status: delta.status,
    rows: delta.rows.length,
    headSeq: delta.headSeq,
    ...(delta.status === "error" ? { error: delta.error } : {}),
  };
  return React.createElement("span", { "data-testid": "probe" });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderProbe(agentId: string): Promise<void> {
  ensureMounted();
  // Render inside act so effects (and the delta loop kick) flush before
  // the caller polls: cross-scope commits are at the mercy of scheduler
  // timing and flaked under parallel workers.
  await act(async () => {
    root?.render(React.createElement(Probe, { agentId }));
  });
}

function ensureMounted() {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
}

/**
 * Poll in SEPARATE short act scopes until the hook leaves loading.
 * Separate scopes matter: React flushes committed renders at scope exit,
 * so the next iteration observes them. (One long scope never observes
 * progress — renders stay batched until it exits.) Slow boxes just take
 * more 25ms hops instead of flaking on a fixed sleep.
 */
async function settleUntil(
  predicate: (current: ProbeView) => boolean,
  // Generous: happy paths resolve in a few hops; only failure paths pay.
  // (Loaded dev boxes stretch 25ms hops under parallel vitest workers.)
  timeoutMs = 10_000,
): Promise<ProbeView> {
  const start = Date.now();
  for (;;) {
    const current = probeRef.current;
    if (current !== null && predicate(current)) return current;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for settled delta: ${JSON.stringify(current)}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

const settledLive = (current: ProbeView): boolean => current.status === "live";
const settledError = (current: ProbeView): boolean => current.status === "error";

async function quietSettle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function view(): ProbeView {
  const current = probeRef.current;
  if (!current) throw new Error("probe never rendered");
  return current;
}

beforeEach(() => {
  rpcHandlers.current = {};
  rpcFns.current = {};
  probeRef.current = null;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  vi.restoreAllMocks();
});

describe("useTrajectoryDelta", () => {
  it("lists once, drains changes while events flow, parks on empty (no hot loop)", async () => {
    const listCalls: unknown[] = [];
    const changesCalls: number[] = [];
    rpcHandlers.current = {
      "trajectory.list": (async (input: unknown) => {
        listCalls.push(input);
        return {
          events: [userMsg(1), assistantMsg(2, 1)],
          headSeq: 2,
        };
      }) as RpcHandler,
      "trajectory.changes": (async (input: unknown) => {
        const { afterSeq } = input as { afterSeq: number };
        changesCalls.push(afterSeq);
        if (afterSeq === 2) return { events: [toolCall(3, 1)], headSeq: 3 };
        if (afterSeq === 3) return { events: [toolResult(4, 1)], headSeq: 4 };
        return { events: [], headSeq: 4 };
      }) as RpcHandler,
    };

    await renderProbe("a1");
    const done = await settleUntil(settledLive);
    expect(done).toMatchObject({ status: "live", rows: 3, headSeq: 4 });

    // Parked: no further changes calls without a kick.
    const parked = changesCalls.length;
    expect(parked).toBeGreaterThan(0);
    await quietSettle(100);
    expect(changesCalls).toHaveLength(parked);
  });

  it("never schedules interval timers", async () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    rpcHandlers.current = {
      "trajectory.list": (async () => ({ events: [userMsg(1)], headSeq: 1 })) as RpcHandler,
      "trajectory.changes": (async () => ({ events: [], headSeq: 1 })) as RpcHandler,
    };

    await renderProbe("a1");
    await settleUntil(settledLive);

    expect(view().status).toBe("live");
    expect(intervalSpy).not.toHaveBeenCalled();
  });

  it("empty first page still resolves loading (new agent, no turns yet)", async () => {
    rpcHandlers.current = {
      "trajectory.list": (async () => ({ events: [], headSeq: 0 })) as RpcHandler,
      "trajectory.changes": (async () => ({ events: [], headSeq: 0 })) as RpcHandler,
    };

    await renderProbe("fresh");
    const done = await settleUntil(settledLive);
    expect(done).toMatchObject({ status: "live", rows: 0, headSeq: 0 });
  });

  it("failed pages keep last rows with error status; agent change resets", async () => {
    let failChanges = true;
    rpcHandlers.current = {
      "trajectory.list": (async (input: unknown) => {
        const { agentId } = input as { agentId: string };
        const base = agentId === "a1" ? 0 : 10;
        return {
          events: [userMsg(base + 1), assistantMsg(base + 2, 1)],
          headSeq: base + 2,
        };
      }) as RpcHandler,
      "trajectory.changes": (async () => {
        if (failChanges) throw new Error("daemon hiccup");
        return { events: [], headSeq: 99 };
      }) as RpcHandler,
    };

    await renderProbe("a1");
    await settleUntil(settledError);

    // list(2 rows) ok, first changes throws -> error keeps the 2 folded rows.
    expect(view()).toMatchObject({ status: "error", rows: 2, headSeq: 2 });
    expect(view().error).toContain("daemon hiccup");

    // New agent resets to loading, then lists its own window. Key the wait
    // on the new headSeq: the stale a1 error already satisfies settledError.
    await renderProbe("a2");
    await settleUntil((current) => current.status === "error" && current.headSeq === 12);
    expect(view()).toMatchObject({ status: "error", rows: 2, headSeq: 12 });
  });
});
