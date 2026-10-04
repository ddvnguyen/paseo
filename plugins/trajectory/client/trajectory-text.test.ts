/** On-demand text resolver: keying, resolution, degradation, cache, visibility. */

import { describe, expect, it, vi } from "vitest";
import type { TrajectoryCellProps } from "../shared/dsh/record.js";
import {
  foldRowTextKeys,
  resolveVisibleText,
  textKey,
  type TextCache,
  type TimelineEntryLike,
  type TimelineRefetch,
} from "./trajectory-text.js";

function cell(overrides: Partial<TrajectoryCellProps> = {}): TrajectoryCellProps {
  return {
    index: 1,
    kind: "message",
    text: "assistant message (84 chars)",
    timeSeconds: 0,
    ...overrides,
  };
}

function entry(overrides: Partial<TimelineEntryLike> = {}): TimelineEntryLike {
  return {
    item: { type: "user_message", text: "run the test suite", messageId: "m1" },
    ...overrides,
  };
}

const OK: TimelineRefetch = async () => ({ entries: [entry()] });

describe("textKey", () => {
  it("prefers the source message id, then the call id", () => {
    expect(textKey(cell({ sourceMessageId: "m1", callId: "c1" }))).toBe("m:m1");
    expect(textKey(cell({ callId: "c1" }))).toBe("c:c1");
  });

  it("returns null for a row with no identity at all", () => {
    // A row recorded before the identity existed, or from a producer that sent
    // none: it can never resolve, and that must not be an error.
    expect(textKey(cell())).toBeNull();
    expect(textKey(cell({ sourceMessageId: "" }))).toBeNull();
  });
});

describe("resolveVisibleText", () => {
  it("fills the cache from a fetched page", async () => {
    const cache: TextCache = new Map();
    const unresolved = await resolveVisibleText({
      cells: [cell({ sourceMessageId: "m1" })],
      agentId: "a1",
      refetch: OK,
      cache,
    });

    expect(cache.get("m:m1")).toBe("run the test suite");
    expect(unresolved.size).toBe(0);
  });

  it("resolves a tool row by call id", async () => {
    const cache: TextCache = new Map();
    await resolveVisibleText({
      cells: [cell({ kind: "tool", callId: "c1" })],
      agentId: "a1",
      refetch: async () => ({ entries: [entry({ item: undefined, callId: "c1" })] }),
      cache,
    });

    // A tool entry carries no message text, so nothing is cached for it — the
    // row keeps its length label rather than showing something wrong.
    expect(cache.size).toBe(0);
  });

  it("reports a key as unresolved when the page has no match", async () => {
    const cache: TextCache = new Map();
    const unresolved = await resolveVisibleText({
      cells: [cell({ sourceMessageId: "absent" })],
      agentId: "a1",
      refetch: OK,
      cache,
    });

    expect(unresolved.has("m:absent")).toBe(true);
    expect(cache.size).toBe(0);
  });

  it("degrades quietly when the fetch fails", async () => {
    const cache: TextCache = new Map();
    const refetch = vi.fn(async () => {
      throw new Error("daemon unreachable");
    });
    const unresolved = await resolveVisibleText({
      cells: [cell({ sourceMessageId: "m1" })],
      agentId: "a1",
      refetch,
      cache,
    });

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(unresolved.has("m:m1")).toBe(true);
    expect(cache.size).toBe(0);
  });

  it("never fetches when every wanted key is already cached", async () => {
    const cache: TextCache = new Map([["m:m1", "already here"]]);
    const refetch = vi.fn(OK);

    await resolveVisibleText({
      cells: [cell({ sourceMessageId: "m1" })],
      agentId: "a1",
      refetch,
      cache,
    });

    expect(refetch).not.toHaveBeenCalled();
    expect(cache.get("m:m1")).toBe("already here");
  });

  it("never fetches when no visible row has an identity", async () => {
    const refetch = vi.fn(OK);
    const unresolved = await resolveVisibleText({
      cells: [cell(), cell()],
      agentId: "a1",
      refetch,
      cache: new Map(),
    });

    expect(refetch).not.toHaveBeenCalled();
    expect(unresolved.size).toBe(0);
  });

  it("fetches once for a batch of visible rows", async () => {
    const refetch = vi.fn(async () => ({
      entries: [
        entry(),
        entry({ item: { type: "assistant_message", text: "done", messageId: "m2" } }),
      ],
    }));
    const cache: TextCache = new Map();

    await resolveVisibleText({
      cells: [cell({ sourceMessageId: "m1" }), cell({ sourceMessageId: "m2" })],
      agentId: "a1",
      refetch,
      cache,
    });

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(cache.get("m:m1")).toBe("run the test suite");
    expect(cache.get("m:m2")).toBe("done");
  });

  it("ignores non-message items so a tool entry cannot supply message text", async () => {
    const cache: TextCache = new Map();
    await resolveVisibleText({
      cells: [cell({ sourceMessageId: "m1" })],
      agentId: "a1",
      refetch: async () => ({
        entries: [entry({ item: { type: "tool_call", text: "shell output", messageId: "m1" } })],
      }),
      cache,
    });

    expect(cache.size).toBe(0);
  });

  // --- merged response keys (owner item 11) -------------------------------

  it("collects every distinct key a merged response row needs", () => {
    const keys = foldRowTextKeys({
      sourceMessageId: "m-1",
      sourceMessageIds: ["m-1", "m-2", "m-1"],
    });
    // Distinct and in order: the body is fetched once per real message and
    // composed in sequence, not once per stream chunk.
    expect(keys).toEqual(["m:m-1", "m:m-2"]);
  });

  it("falls back to a single key when the row carries no id list", () => {
    expect(foldRowTextKeys({ sourceMessageId: "m-1" })).toEqual(["m:m-1"]);
    expect(foldRowTextKeys({ callId: "c-1" })).toEqual(["c:c-1"]);
  });

  it("resolves nothing for a row with no source identity", () => {
    expect(foldRowTextKeys({})).toEqual([]);
    expect(foldRowTextKeys({ sourceMessageId: null })).toEqual([]);
  });
});
