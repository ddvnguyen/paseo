/** Delta-loop hook tests: drain-then-park, error keeps rows, no timers. */

// @vitest-environment jsdom
// Expose the act() support flag before react loads; no suppression is needed now
// that the plugin tsconfig resolves real react types.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeStore } from "../server/node-store.js";
import { handleChanges, handleList } from "../server/rpc.js";
import type { TrajectoryStore } from "../server/store.js";
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
  hasOlderHistory: boolean;
  loadOlder: () => void;
  error?: string;
}

const probeRef: { current: ProbeView | null } = { current: null };
/** The hook's `refresh()`, i.e. the kick that re-enters the drain loop. */
const refreshRef: { current: (() => void) | null } = { current: null };

function Probe({ agentId }: { agentId: string }) {
  const delta = useTrajectoryDelta(agentId);
  probeRef.current = {
    status: delta.status,
    rows: delta.rows.length,
    headSeq: delta.headSeq,
    hasOlderHistory: delta.hasOlderHistory,
    loadOlder: delta.loadOlder,
    ...(delta.status === "error" ? { error: delta.error } : {}),
  };
  refreshRef.current = delta.refresh;
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
  refreshRef.current = null;
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

/** Shared by both suites that drive the real store and handlers. */
/** One turn per 4 events so tool/call and tool/result stay paired. */
function seed(store: TrajectoryStore, total: number, agentId: string): void {
  for (let i = 1; i <= total; i++) {
    const cycle = Math.ceil(i / 4);
    const kind = i % 4;
    const turn = `t${cycle}`;
    const callId = `c${cycle}`;
    if (kind === 1)
      store.append({
        time: iso(i),
        type: "user/message",
        turn,
        step: null,
        agentId,
        data: { textLength: 10 },
      });
    else if (kind === 2)
      store.append({
        time: iso(i),
        type: "assistant/message",
        turn,
        step: 1,
        agentId,
        data: { textLength: 20 },
      });
    else if (kind === 3)
      store.append({
        time: iso(i),
        type: "tool/call",
        turn,
        step: 1,
        agentId,
        data: { callId, name: "shell" },
      });
    else
      store.append({
        time: iso(i),
        type: "tool/result",
        turn,
        step: 1,
        agentId,
        data: { callId, name: "shell", durationMs: 400, outputChars: 12 },
      });
  }
}

const iso = (seq: number) => new Date(BASE + seq * 1_000).toISOString();

/**
 * Wire the real handlers, teeing every seq the hook is handed. The hook folds
 * into rows that drop structure-only events and merge tool pairs, so the
 * buffered *event* seqs are the only faithful record of what was delivered.
 */
function wireRealStore(store: TrajectoryStore): {
  received: number[];
  listInputs: { agentId: string; afterSeq?: number; beforeSeq?: number; limit?: number }[];
} {
  const received: number[] = [];
  const listInputs: { agentId: string; afterSeq?: number; beforeSeq?: number; limit?: number }[] =
    [];
  const teeChanges = async (input: never) => {
    const page = await handleChanges(store)(input);
    received.push(...page.events.map((event) => event.seq));
    return page;
  };
  const teeList = async (input: never) => {
    listInputs.push(input as { agentId: string; beforeSeq?: number });
    const page = await handleList(store)(input);
    received.push(...page.events.map((event) => event.seq));
    return page;
  };
  rpcHandlers.current = {
    "trajectory.list": teeList as RpcHandler,
    "trajectory.changes": teeChanges as RpcHandler,
  };
  return { received, listInputs };
}

/** The seq values missing from [min, max] of `seqs`. */
function holesIn(seqs: readonly number[]): number[] {
  if (seqs.length === 0) return [];
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  const missing: number[] = [];
  for (let i = sorted[0]; i <= sorted[sorted.length - 1]; i++) {
    if (!sorted.includes(i)) missing.push(i);
  }
  return missing;
}

const range = (seqs: readonly number[]) =>
  seqs.length === 0 ? "(empty)" : `${Math.min(...seqs)}..${Math.max(...seqs)}`;

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
      "trajectory.changes": (async (input: unknown) => {
        if (failChanges) throw new Error("daemon hiccup");
        // An empty page reports the cursor the caller sent (see the page
        // contract in shared/trajectory.ts). A headSeq ahead of the cursor on
        // an empty page is the shape the torn-ledger fix removes, so it must
        // not be what these mocks teach.
        const { afterSeq } = input as { afterSeq: number };
        return { events: [], headSeq: afterSeq };
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

/**
 * Backlog paging. These drive the hook against the REAL store and the REAL rpc
 * handlers (only `useRpc` is mocked), so the server's paging and its `headSeq`
 * are what the assertions actually measure. A hand-written fake would only
 * prove the fake is self-consistent.
 *
 * The mocks above cannot catch the backlog defect: every page they return
 * happens to be the whole table, so `headSeq` is both the page tail and the
 * global max at once, and the two readings are indistinguishable. That
 * coincidence is why the torn-ledger defect survived QC.
 */
describe("useTrajectoryDelta against the real store (backlog paging)", () => {
  const TOTAL = 1200;
  const PAGE = 500;

  it("drains the newest window and parks at the true head, with no hole inside it", async () => {
    const store = createNodeStore(":memory:");
    try {
      seed(store, TOTAL, "a1");
      const { received } = wireRealStore(store);

      await renderProbe("a1");
      const done = await settleUntil(settledLive);

      // The defect in one assertion: the client must end up holding the newest
      // events and parked on the newest seq. Returning the oldest page leaves
      // max(received) at the page tail while headSeq claims the real head.
      expect({
        delivered: range(received),
        deliveredMax: Math.max(...received),
        hookHeadSeq: done.headSeq,
        trueHead: store.headSeq("a1"),
      }).toEqual({
        delivered: "701..1200",
        deliveredMax: TOTAL,
        hookHeadSeq: TOTAL,
        trueHead: TOTAL,
      });

      // Contiguous: the window is a gap-free suffix, never a torn ledger.
      expect(holesIn(received)).toEqual([]);
      expect(received.length).toBeLessThanOrEqual(PAGE);
    } finally {
      store.close();
    }
  });

  /**
   * A backlog that arrives AFTER the ledger has parked, which is the live case
   * the drain loop exists for. The two tests above start from a fresh open,
   * where `list` returns the tail and the next `changes` is empty, so the drain
   * never has to walk. This one forces it to.
   *
   * A forward drain must step forward one page at a time. If `changes` selects
   * the newest N above the cursor instead of the oldest N, a backlog larger
   * than one page is consumed from the end: the client receives the last page,
   * parks on it, and the middle of the backlog is unreachable by any
   * `seq > afterSeq` poll. That is the same torn ledger, in a different place.
   */
  it("drains a backlog that arrives after parking, without skipping its middle", async () => {
    const store = createNodeStore(":memory:");
    try {
      seed(store, TOTAL, "a1");
      const { received } = wireRealStore(store);

      await renderProbe("a1");
      const opened = await settleUntil(settledLive);
      expect({ openedRange: range(received), headSeq: opened.headSeq }).toEqual({
        openedRange: "701..1200",
        headSeq: TOTAL,
      });

      // The ledger goes quiet, then a backlog lands out of band.
      await quietSettle(50);
      const backlog = 1000;
      seed(store, backlog, "a1");
      const trueHead = store.headSeq("a1");
      expect(trueHead).toBe(TOTAL + backlog);

      // One kick, exactly as a manual refresh or an agent update would do it.
      await act(async () => {
        refreshRef.current?.();
      });
      const drained = await settleUntil((current) => current.headSeq === trueHead);

      // Every row of the backlog arrived, and the window has no hole in it.
      const backlogDelivered = received.filter((seq) => seq > TOTAL).length;
      expect({
        backlogDelivered,
        expectedBacklog: backlog,
        deliveredRange: range(received),
        holes: holesIn(received).length,
        headSeq: drained.headSeq,
        trueHead,
      }).toEqual({
        backlogDelivered: backlog,
        expectedBacklog: backlog,
        deliveredRange: `701..${trueHead}`,
        holes: 0,
        headSeq: trueHead,
        trueHead,
      });
    } finally {
      store.close();
    }
  });
});

/**
 * Load older. The reverse read exists server-side since S1 (beforeSeq on
 * trajectory.list) but nothing in the client has ever sent it, so the page, its
 * loading state, and the exhausted flag are all built here.
 */
describe("useTrajectoryDelta load-older", () => {
  const TOTAL = 1200;

  /** A ledger of `total` events, seq 1..total, all on agent a1. */
  function seedLoadOlder(store: TrajectoryStore, total: number, agentId: string): void {
    for (let i = 1; i <= total; i++) {
      store.append({
        time: iso(i),
        type: i % 2 === 1 ? "user" : "assistant",
        turn: `t${Math.ceil(i / 2)}`,
        step: null,
        agentId,
        data: {},
      });
    }
  }

  /** Lets pending promise chains settle, without polling for a condition only
   *  the new code could produce (that reads as a timeout, not an assertion). */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  const beforeSeqReads = (inputs: readonly { beforeSeq?: number }[]): number[] =>
    inputs.flatMap((input) => (input.beforeSeq === undefined ? [] : [input.beforeSeq]));

  it("reads the page below the oldest buffered seq and prepends it", async () => {
    const store = createNodeStore(":memory:");
    try {
      seedLoadOlder(store, TOTAL, "a1");
      const { listInputs, received } = wireRealStore(store);
      await renderProbe("a1");
      await settleUntil(settledLive);
      // The open page is the newest 500, so the oldest buffered seq is 701.
      expect({ opened: range(received), headSeq: view().headSeq }).toEqual({
        opened: "701..1200",
        headSeq: TOTAL,
      });

      await act(async () => {
        view().loadOlder();
      });
      await settle();

      // One press is one page, and the cursor it read with is the oldest
      // buffered seq, not the head.
      expect({ beforeSeq: beforeSeqReads(listInputs) }).toEqual({ beforeSeq: [701] });
      // Prepended, still contiguous, and 500 rows not 1000: the page is the
      // newest 500 below the cursor, so 201..700.
      expect({ union: range(received), holes: holesIn(received).length }).toEqual({
        union: "201..1200",
        holes: 0,
      });

      // The next press pages from the NEW oldest seq, so walking to exhaustion
      // reaches the start with no hole at any step.
      await act(async () => {
        view().loadOlder();
      });
      await settle();
      expect({ beforeSeq: beforeSeqReads(listInputs) }).toEqual({ beforeSeq: [701, 201] });
      expect({ union: range(received), holes: holesIn(received).length }).toEqual({
        union: "1..1200",
        holes: 0,
      });
    } finally {
      store.close();
    }
  });

  it("two rapid calls fetch once — the in-flight lock is the whole point", async () => {
    const store = createNodeStore(":memory:");
    try {
      seedLoadOlder(store, TOTAL, "a1");
      const { listInputs } = wireRealStore(store);
      await renderProbe("a1");
      await settleUntil(settledLive);

      // Three presses in one tick, before the first read resolves. A sequential
      // test can never see this: the lock exists to stop concurrent re-entry,
      // and pressing twice in a row after a resolve would be two legitimate
      // pages, not a double-fetch.
      await act(async () => {
        view().loadOlder();
        view().loadOlder();
        view().loadOlder();
      });
      await settle();

      expect({ beforeSeqReads: beforeSeqReads(listInputs).length }).toEqual({ beforeSeqReads: 1 });
    } finally {
      store.close();
    }
  });

  it("the affordance disappears once older history is exhausted", async () => {
    const store = createNodeStore(":memory:");
    try {
      // Fewer events than one page: the open already returned everything, so
      // there is nothing below it.
      seedLoadOlder(store, 10, "a1");
      const { listInputs } = wireRealStore(store);
      await renderProbe("a1");
      await settleUntil(settledLive);

      await act(async () => {
        view().loadOlder();
      });
      await settle();

      // An exhausted ledger answers with an empty page, which is how we know —
      // and per the S1 empty-page contract that page echoes the cursor, so it
      // cannot rewind the head.
      expect({
        hasOlderHistory: view().hasOlderHistory,
        beforeSeqReads: beforeSeqReads(listInputs),
        headSeq: view().headSeq,
      }).toEqual({ hasOlderHistory: false, beforeSeqReads: [1], headSeq: 10 });
    } finally {
      store.close();
    }
  });
});
