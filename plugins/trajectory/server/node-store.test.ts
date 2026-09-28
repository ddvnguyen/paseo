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
      const rows = store.listByAgent("agent-1", { limit: 10 });
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
      const page = store.listByAgent("agent-1", { afterSeq: a.seq, limit: 10 });
      expect(page).toHaveLength(2);
      expect(page[0].seq).toBe(b.seq);
      expect(page[1].seq).toBe(c.seq);
      expect(page.every((row) => row.seq > a.seq)).toBe(true);
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
      const page = store.listByAgent("agent-1", { limit: 4 });
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
      expect(store.listByAgent("agent-1", { limit: 1000 }).map((row) => row.seq)).toEqual([
        1, 2, 3,
      ]);
    } finally {
      store.close();
    }
  });

  test("events of another agent are excluded", () => {
    const store = createNodeStore(":memory:");
    try {
      store.append(input());
      store.append(input({ agentId: "agent-2", turn: null }));
      const rows = store.listByAgent("agent-1", { limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0].agentId).toBe("agent-1");
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
      const all = second.listByAgent("agent-1", { limit: 100 });
      expect(all).toHaveLength(2);
    } finally {
      second.close();
    }
  });
});

const fileDir = mkdtempSync(join(tmpdir(), "trajectory-store-test-"));
