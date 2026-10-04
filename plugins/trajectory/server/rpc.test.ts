import { describe, expect, test } from "vitest";
import { foldSnapshot } from "../shared/fold.js";
import {
  TrajectorySnapshotSchema,
  trajectoryList,
  trajectorySubscribe,
  type TrajectoryEvent,
} from "../shared/trajectory.js";
import { createNodeStore } from "./node-store.js";
import { handleChanges, handleList, handleSubscribe } from "./rpc.js";
import type { TrajectoryStore } from "./store.js";

describe("trajectory read handlers", () => {
  test("list returns ascending events + headSeq; changes returns only newer rows", async () => {
    const store = createNodeStore(":memory:");
    const base = Date.parse("2026-09-26T00:00:00Z");
    const rows = [
      { type: "turn/start", turn: "t1", data: {} },
      { type: "assistant/message", turn: "t1", step: 1, data: { textLength: 9 } },
      { type: "turn/end", turn: "t1", data: { outcome: "completed" } },
    ];
    for (const [index, row] of rows.entries()) {
      store.append({
        ...row,
        time: new Date(base + index * 1000).toISOString(),
        step: row.step ?? null,
        agentId: "agent-1",
      });
    }

    const list = await handleList(store)({ agentId: "agent-1", limit: 100 });
    expect(list.events).toHaveLength(3);
    expect(list.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(list.headSeq).toBe(3);

    const changes = await handleChanges(store)({ agentId: "agent-1", afterSeq: 2, limit: 100 });
    expect(changes.events.map((event) => event.type)).toEqual(["turn/end"]);
    expect(changes.headSeq).toBe(3);

    // The wire contract parses the list output (schema round-trip).
    const parsed = trajectoryList.output.parse(list);
    expect(parsed.events[0].agentId).toBe("agent-1");

    // And the fold accepts the same rows end-to-end.
    const snapshot = foldSnapshot("agent-1", parsed.events, parsed.headSeq);
    expect(TrajectorySnapshotSchema.parse(snapshot).turns).toHaveLength(1);
    store.close();
  });

  test("unknown agent: empty page, headSeq 0", async () => {
    const store = createNodeStore(":memory:");
    const list = await handleList(store)({ agentId: "nobody", limit: 50 });
    expect(list.events).toEqual([]);
    expect(list.headSeq).toBe(0);
    store.close();
  });

  /**
   * `headSeq` is the page's own last seq, never the agent's global MAX(seq).
   * The two are indistinguishable whenever a page covers the whole backlog,
   * which is why the mismatch survives review: the tests above all page a table
   * that fits in one page.
   */
  test("headSeq is the page tail, not the global max, when the backlog exceeds the page", async () => {
    const store = createNodeStore(":memory:");
    try {
      for (let i = 0; i < 10; i++) {
        store.append({
          time: "2026-09-26T00:00:00.000Z",
          type: "assistant/message",
          turn: "t1",
          step: null,
          agentId: "agent-1",
          data: {},
        });
      }

      // Deliberately a `changes` page and not a `list` one: for a tail-first
      // `list` the page tail IS the global max, so that shape cannot tell the
      // two apart and the assertion would pass either way. Draining forward
      // from a cursor puts the page tail in the middle of the backlog.
      const page = await handleChanges(store)({ agentId: "agent-1", afterSeq: 2, limit: 3 });
      expect(page.events.map((event) => event.seq)).toEqual([3, 4, 5]);
      expect({
        headSeq: page.headSeq,
        pageTail: page.events[page.events.length - 1].seq,
        globalMax: store.headSeq("agent-1"),
      }).toEqual({ headSeq: 5, pageTail: 5, globalMax: 10 });
    } finally {
      store.close();
    }
  });

  test("an empty page reports the caller's cursor, so the cursor cannot rewind", async () => {
    const store = createNodeStore(":memory:");
    try {
      for (let i = 0; i < 3; i++) {
        store.append({
          time: "2026-09-26T00:00:00.000Z",
          type: "assistant/message",
          turn: "t1",
          step: null,
          agentId: "agent-1",
          data: {},
        });
      }
      // Parked at the head: nothing newer, and the cursor must stay put rather
      // than dropping to 0 (which would re-read the ledger from the start).
      const parked = await handleChanges(store)({ agentId: "agent-1", afterSeq: 3, limit: 10 });
      expect(parked.events).toEqual([]);
      expect(parked.headSeq).toBe(3);
    } finally {
      store.close();
    }
  });

  /**
   * The race that a second `MAX(seq)` query opens. A write landing between the
   * page read and the cursor computation is invisible to the client: it holds
   * seqs 1..3, and a global-max cursor would hand it 5 — naming two rows it
   * never received, which no later `seq > afterSeq` poll can return.
   *
   * Reproduced with a store whose page read has the write land as a side
   * effect, because node:sqlite is synchronous and cannot interleave on its
   * own. The assertion is that those rows survive the cursor.
   */
  test("a write landing inside the page read stays reachable by the next poll", async () => {
    const rows: TrajectoryEvent[] = [];
    let seq = 0;
    const make = (): TrajectoryEvent => {
      seq += 1;
      const event: TrajectoryEvent = {
        seq,
        time: "2026-09-26T00:00:00.000Z",
        type: "assistant/message",
        turn: "t1",
        step: null,
        agentId: "agent-1",
        data: {},
      };
      rows.push(event);
      return event;
    };
    for (let i = 0; i < 3; i++) make();

    // A write lands after the page is read but before the cursor is computed.
    let raced = false;
    const racy: TrajectoryStore = {
      append: () => {
        throw new Error("not used");
      },
      listByAgent: (_agentId, opts) => {
        const page = rows.filter((row) => row.seq > (opts.afterSeq ?? 0)).slice(-opts.limit);
        if (!raced) {
          raced = true;
          make();
          make();
        }
        return page;
      },
      headSeq: () => rows[rows.length - 1]?.seq ?? 0,
      close: () => {},
    };

    const first = await handleList(racy)({ agentId: "agent-1", limit: 10 });
    expect(first.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    // The cursor names a row the client holds, never one written behind it.
    expect(first.headSeq).toBe(3);

    const next = await handleChanges(racy)({
      agentId: "agent-1",
      afterSeq: first.headSeq,
      limit: 10,
    });
    expect(next.events.map((event) => event.seq)).toEqual([4, 5]);
  });

  /**
   * The direction split is the read path's load-bearing property, so it is
   * asserted per RPC rather than only at the store: `list` opens at the head,
   * `changes` walks forward from the cursor. A single shared default is how one
   * caller's policy silently becomes the other's.
   */
  test("list opens at the head while changes walks forward from the cursor", async () => {
    const store = createNodeStore(":memory:");
    try {
      for (let i = 0; i < 10; i++) {
        store.append({
          time: "2026-09-26T00:00:00.000Z",
          type: "assistant/message",
          turn: "t1",
          step: null,
          agentId: "agent-1",
          data: {},
        });
      }

      // The open spends its page on the head of the ledger.
      const opened = await handleList(store)({ agentId: "agent-1", limit: 3 });
      expect(opened.events.map((event) => event.seq)).toEqual([8, 9, 10]);

      // The drain from a cursor takes the rows just above it, not the tail.
      const drained = await handleChanges(store)({ agentId: "agent-1", afterSeq: 2, limit: 3 });
      expect(drained.events.map((event) => event.seq)).toEqual([3, 4, 5]);
      expect(drained.headSeq).toBe(5);

      // …so a backlog larger than a page is fully reachable by walking forward.
      const walked: number[] = [];
      let cursor = 0;
      for (let guard = 0; guard < 20; guard++) {
        const page = await handleChanges(store)({ agentId: "agent-1", afterSeq: cursor, limit: 3 });
        if (page.events.length === 0) break;
        walked.push(...page.events.map((event) => event.seq));
        cursor = page.headSeq;
      }
      expect(walked).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      store.close();
    }
  });

  /**
   * `headSeq` is the forward cursor only for a FORWARD page. On a reverse page
   * it is the page's own tail — its OLDEST row — so adopting it as the next
   * `afterSeq` rewinds past rows the caller already holds and re-delivers them.
   * Pinned because the field is identical either way, so nothing in the types
   * stops a caller from getting this wrong; the page contract comment is the
   * only thing warning it.
   */
  test("a reverse page reports a headSeq that is NOT a usable forward cursor", async () => {
    const store = createNodeStore(":memory:");
    try {
      for (let i = 0; i < 10; i++) {
        store.append({
          time: "2026-09-26T00:00:00.000Z",
          type: "assistant/message",
          turn: "t1",
          step: null,
          agentId: "agent-1",
          data: {},
        });
      }
      // A client at the tail holds seq 10; it pages backwards from seq 7.
      const forwardCursor = 10;
      const older = await handleList(store)({ agentId: "agent-1", beforeSeq: 7, limit: 4 });

      expect({
        events: older.events.map((event) => event.seq),
        // Still the page's own last seq — that part of the contract holds.
        headSeq: older.headSeq,
        isPageTail: older.headSeq === older.events[older.events.length - 1].seq,
        // …and sending it as afterSeq would rewind the cursor.
        wouldRewind: older.headSeq < forwardCursor,
      }).toEqual({
        events: [3, 4, 5, 6],
        headSeq: 6,
        isPageTail: true,
        wouldRewind: true,
      });
    } finally {
      store.close();
    }
  });

  test("subscribe serves the same paged read as changes (push-reserved name)", async () => {
    const store = createNodeStore(":memory:");
    const base = Date.parse("2026-09-26T00:00:00Z");
    const rows = [
      { type: "turn/start", turn: "t1", data: {} },
      { type: "assistant/message", turn: "t1", step: 1, data: { textLength: 4 } },
      { type: "turn/end", turn: "t1", data: { outcome: "completed" } },
    ];
    for (const [index, row] of rows.entries()) {
      store.append({
        ...row,
        time: new Date(base + index * 1000).toISOString(),
        step: row.step ?? null,
        agentId: "agent-9",
      });
    }

    const input = { agentId: "agent-9", afterSeq: 1, limit: 100 };
    const viaSubscribe = await handleSubscribe(store)(input);
    const viaChanges = await handleChanges(store)(input);
    expect(viaSubscribe).toEqual(viaChanges);
    expect(viaSubscribe.events.map((event) => event.type)).toEqual([
      "assistant/message",
      "turn/end",
    ]);
    expect(viaSubscribe.headSeq).toBe(3);

    // The reserved contract parses its own output.
    expect(trajectorySubscribe.output.parse(viaSubscribe).headSeq).toBe(3);
    store.close();
  });
});
