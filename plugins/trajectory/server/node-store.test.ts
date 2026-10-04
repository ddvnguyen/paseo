import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { createNodeStore } from "./node-store.js";
import type { TrajectoryEventInput } from "./store.js";

afterAll(() => {
  rmSync(fileDir, { recursive: true, force: true });
});

function input(overrides: Partial<TrajectoryEventInput> = {}): TrajectoryEventInput {
  return {
    time: "2026-09-26T00:00:00.000Z",
    type: "turn.started",
    turn: "turn-1",
    step: null,
    agentId: "agent-1",
    data: { provider: "opencode" },
    ...overrides,
  };
}

describe("node store (db-assigned seq)", () => {
  test("append 3 events -> seq strictly increasing", () => {
    const store = createNodeStore(":memory:");
    try {
      const a = store.append(input());
      const b = store.append(input({ type: "tool.completed" }));
      const c = store.append(input({ type: "turn.completed" }));
      expect(a.seq).toBeGreaterThan(0);
      expect(b.seq).toBeGreaterThan(a.seq);
      expect(c.seq).toBeGreaterThan(b.seq);
    } finally {
      store.close();
    }
  });

  test("listByAgent returns camelCase fields and parsed data", () => {
    const store = createNodeStore(":memory:");
    try {
      const appended = store.append(
        input({ data: { provider: "claude", usage: { inputTokens: 10 } } }),
      );
      const rows = store.listByAgent("agent-1", { limit: 10, direction: "newest" });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      // Fix-1 regression: snake_case columns must surface as camelCase.
      expect(row.agentId).toBe("agent-1");
      expect(row.agentId).not.toBeUndefined();
      expect(row.turn).toBe("turn-1");
      expect(row.turn).not.toBeUndefined();
      expect(row.seq).toBe(appended.seq);
      expect(row.data).toEqual({ provider: "claude", usage: { inputTokens: 10 } });
    } finally {
      store.close();
    }
  });

  test("afterSeq paging returns only newer rows, ascending", () => {
    const store = createNodeStore(":memory:");
    try {
      const a = store.append(input());
      const b = store.append(input());
      const c = store.append(input());
      const page = store.listByAgent("agent-1", {
        afterSeq: a.seq,
        limit: 10,
        direction: "oldest",
      });
      expect(page).toHaveLength(2);
      expect(page[0].seq).toBe(b.seq);
      expect(page[1].seq).toBe(c.seq);
      expect(page.every((row) => row.seq > a.seq)).toBe(true);
    } finally {
      store.close();
    }
  });

  test("events of another agent are excluded", () => {
    const store = createNodeStore(":memory:");
    try {
      store.append(input());
      store.append(input({ agentId: "agent-2", turn: null }));
      const rows = store.listByAgent("agent-1", { limit: 10, direction: "newest" });
      expect(rows).toHaveLength(1);
      expect(rows[0].agentId).toBe("agent-1");
    } finally {
      store.close();
    }
  });

  /**
   * Pinned at the store level because the property is the SQL's, not the
   * client's: the page must be the NEWEST `limit` rows AND come back
   * ascending. Either half alone is wrong — an inner-only `ORDER BY seq DESC`
   * selects the right rows and hands the fold a newest-first page, and an
   * outer-only `ORDER BY seq ASC` re-sorts the oldest rows the inner query
   * already limited away.
   */
  test("limit takes the NEWEST rows, returned ascending", () => {
    const store = createNodeStore(":memory:");
    try {
      for (let i = 0; i < 10; i++) store.append(input());
      const page = store.listByAgent("agent-1", { limit: 4, direction: "newest" });
      // Newest four of ten, ascending: 7,8,9,10 — never 1,2,3,4.
      expect(page.map((row) => row.seq)).toEqual([7, 8, 9, 10]);
      expect(page[page.length - 1].seq).toBe(store.headSeq("agent-1"));
    } finally {
      store.close();
    }
  });

  test("a limit larger than the backlog returns everything, ascending", () => {
    const store = createNodeStore(":memory:");
    try {
      for (let i = 0; i < 3; i++) store.append(input());
      expect(
        store.listByAgent("agent-1", { limit: 1000, direction: "newest" }).map((row) => row.seq),
      ).toEqual([1, 2, 3]);
    } finally {
      store.close();
    }
  });

  /**
   * The one property the two callers disagree about, pinned at the store: the
   * same bounds and limit return opposite ENDS depending on `direction`. Both
   * return ascending, so the difference is which rows, never the order.
   */
  test("direction picks which end of the window comes back, order stays ascending", () => {
    const store = createNodeStore(":memory:");
    try {
      for (let i = 0; i < 10; i++) store.append(input());

      // Forward drain: step from the cursor, do not jump to the end.
      expect(
        store
          .listByAgent("agent-1", { afterSeq: 4, limit: 3, direction: "oldest" })
          .map((r) => r.seq),
      ).toEqual([5, 6, 7]);
      expect(
        store
          .listByAgent("agent-1", { afterSeq: 7, limit: 3, direction: "oldest" })
          .map((r) => r.seq),
      ).toEqual([8, 9, 10]);

      // Initial open: show the head of the ledger.
      expect(
        store.listByAgent("agent-1", { limit: 3, direction: "newest" }).map((r) => r.seq),
      ).toEqual([8, 9, 10]);
      expect(
        store
          .listByAgent("agent-1", { afterSeq: 4, limit: 3, direction: "newest" })
          .map((r) => r.seq),
      ).toEqual([8, 9, 10]);

      // Draining "oldest" until empty visits every row exactly once, which is
      // what a tail-first page cannot do.
      const seen: number[] = [];
      let cursor = 0;
      for (let guard = 0; guard < 20; guard++) {
        const page = store.listByAgent("agent-1", {
          afterSeq: cursor,
          limit: 3,
          direction: "oldest",
        });
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.seq));
        cursor = page[page.length - 1].seq;
      }
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      store.close();
    }
  });

  test("beforeSeq pages backwards without overlapping the forward page", () => {
    const store = createNodeStore(":memory:");
    try {
      for (let i = 0; i < 10; i++) store.append(input());
      const newest = store.listByAgent("agent-1", { limit: 4, direction: "newest" });
      expect(newest.map((row) => row.seq)).toEqual([7, 8, 9, 10]);

      const older = store.listByAgent("agent-1", {
        beforeSeq: newest[0].seq,
        limit: 4,
        direction: "newest",
      });
      expect(older.map((row) => row.seq)).toEqual([3, 4, 5, 6]);
      // Strictly older, no overlap at the boundary.
      expect(older.every((row) => row.seq < newest[0].seq)).toBe(true);

      const olderStill = store.listByAgent("agent-1", {
        beforeSeq: older[0].seq,
        limit: 4,
        direction: "newest",
      });
      expect(olderStill.map((row) => row.seq)).toEqual([1, 2]);
    } finally {
      store.close();
    }
  });

  test("afterSeq and beforeSeq compose into one bounded window", () => {
    const store = createNodeStore(":memory:");
    try {
      for (let i = 0; i < 10; i++) store.append(input());
      const page = store.listByAgent("agent-1", {
        afterSeq: 3,
        beforeSeq: 8,
        limit: 100,
        direction: "newest",
      });
      expect(page.map((row) => row.seq)).toEqual([4, 5, 6, 7]);
    } finally {
      store.close();
    }
  });

  test("file-based db reopened keeps seq monotonic (no seeding needed)", () => {
    const dbPath = join(fileDir, "events.db");
    const first = createNodeStore(dbPath);
    const lastBefore = first.append(input()).seq;
    first.close();

    const second = createNodeStore(dbPath);
    try {
      const after = second.append(input()).seq;
      expect(after).toBeGreaterThan(lastBefore);
      const all = second.listByAgent("agent-1", { limit: 100, direction: "newest" });
      expect(all).toHaveLength(2);
    } finally {
      second.close();
    }
  });

  test("hasToolPhase answers from the rows, so replay dedupe survives a restart", () => {
    const store = createNodeStore(":memory:");
    store.append({
      time: new Date(0).toISOString(),
      type: "tool/call",
      turn: "t1",
      step: null,
      agentId: "agent-1",
      data: { callId: "c1", name: "shell" },
    });
    expect(store.hasToolPhase?.("agent-1", "c1", "call")).toBe(true);
    // The other phase of the same call, another agent, and an unknown call all
    // have to report false — otherwise the backfill would be skipped wrongly.
    expect(store.hasToolPhase?.("agent-1", "c1", "result")).toBe(false);
    expect(store.hasToolPhase?.("agent-2", "c1", "call")).toBe(false);
    expect(store.hasToolPhase?.("agent-1", "nope", "call")).toBe(false);
  });
});

const fileDir = mkdtempSync(join(tmpdir(), "trajectory-store-test-"));

/**
 * The per-agent cursor invariant, as behaviour.
 *
 * The read path is `WHERE agent_id = ? AND seq > cursor`, drained until an empty
 * page. It only walks every row exactly once if `seq` is monotonic AND unique
 * WITHIN an agent, and only stays inside one agent's ledger if the agent_id
 * predicate is in the query. Neither is asserted anywhere else in this file,
 * and a schema refactor — a composite `PRIMARY KEY (agent_id, seq)` or a
 * per-agent counter — is the more natural shape for a per-agent log, so it is
 * not a hypothetical change.
 *
 * Expressed as behaviour on purpose. Asserting the DDL spelling
 * (`seq INTEGER PRIMARY KEY AUTOINCREMENT`) would guard GLOBAL monotonicity,
 * which the cursor does not need: a correct per-agent counter satisfies
 * everything the cursor does. A tripwire whose stated rationale is false is
 * worse than none — it turns a legitimate refactor red while claiming to
 * protect a property it does not check. If a DDL guard is wanted later, assert
 * that seq is unique per agent (rowid, or `UNIQUE(agent_id, seq)`) instead.
 *
 * Both agents write throughout the drain, so a global cursor or a per-agent seq
 * cannot pass.
 */
describe("per-agent cursor invariant", () => {
  const A = "agent-a";
  const B = "agent-b";

  test("draining one agent is complete, duplicate-free, and never leaks the other", () => {
    const store = createNodeStore(":memory:");
    try {
      // Interleaved from the start: the global seq space is shared, so each
      // agent occupies a sparse block of it rather than a contiguous one.
      const writtenA: number[] = [];
      for (let i = 0; i < 20; i++) {
        writtenA.push(store.append(input({ agentId: A })).seq);
        store.append(input({ agentId: B }));
      }

      // Drain A with the cursor, three rows at a time, while B keeps writing
      // between every page. A global cursor would be dragged forward by B's
      // writes and skip A's rows; a per-agent seq would restart under A.
      const drained: { seq: number; agentId: string | null }[] = [];
      let cursor = 0;
      for (let page = 0; page < 200; page++) {
        const rows = store.listByAgent(A, { afterSeq: cursor, limit: 3, direction: "oldest" });
        if (rows.length === 0) break;
        drained.push(...rows.map((row) => ({ seq: row.seq, agentId: row.agentId })));
        cursor = rows[rows.length - 1].seq;
        store.append(input({ agentId: B }));
      }

      const drainedSeqs = drained.map((row) => row.seq);
      expect({
        // Every row A ever wrote, each exactly once, in order.
        coveredExactlyOnce:
          JSON.stringify([...drainedSeqs].sort((x, y) => x - y)) ===
          JSON.stringify([...writtenA].sort((x, y) => x - y)),
        duplicates: drainedSeqs.length - new Set(drainedSeqs).size,
        // The agent predicate is in the query: no foreign row, ever.
        foreignRows: drained.filter((row) => row.agentId !== A).length,
        // Ascending, so the cursor cannot revisit or skip.
        ascending: drainedSeqs.every((seq, index) => index === 0 || drainedSeqs[index - 1] < seq),
      }).toEqual({ coveredExactlyOnce: true, duplicates: 0, foreignRows: 0, ascending: true });
    } finally {
      store.close();
    }
  });
});
