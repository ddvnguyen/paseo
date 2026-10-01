/**
 * Injected-context capture: what the ledger may keep, how the daemon's own
 * appended instructions are sampled, and how staged creates are claimed.
 */

import { describe, expect, it, vi } from "vitest";
import {
  contextKeyOf,
  hash12,
  HASH_CHARS,
  MAX_STAGED_CREATES,
  PendingContextQueue,
  sampleDaemonAppend,
  type ConfigReadable,
} from "./injected-context.js";

const SECRET = "sk-live-DO-NOT-LEAK-9f3a2b";

/** A config reader over one value, or over a throw. */
function reader(value: unknown, options: { throws?: Error } = {}): ConfigReadable {
  return {
    config: {
      get: vi.fn(async () => {
        if (options.throws) throw options.throws;
        return { config: { appendSystemPrompt: value as string | undefined } };
      }),
    },
  };
}

describe("hash12", () => {
  it("is a stable 12-char digest that differs per prompt", () => {
    expect(hash12("hello world")).toHaveLength(HASH_CHARS);
    expect(hash12("hello world")).toBe(hash12("hello world"));
    expect(hash12("hello world")).not.toBe(hash12("hello worlds"));
  });
});

describe("sampleDaemonAppend", () => {
  it("reduces the daemon's appended instructions to length and hash", async () => {
    const facts = await sampleDaemonAppend(reader(SECRET));

    expect(facts).toEqual({ charsLength: SECRET.length, hash12: hash12(SECRET) });
    // The daemon's own instructions can carry a key; the row cannot.
    expect(JSON.stringify(facts)).not.toContain(SECRET);
    expect(JSON.stringify(facts)).not.toContain("DO-NOT-LEAK");
  });

  it("describes the TRIMMED text, which is what the daemon injects", async () => {
    // applyDaemonAppendSystemPrompt injects `this.appendSystemPrompt.trim()`, so
    // a padded setting is shorter than the raw config string.
    const facts = await sampleDaemonAppend(reader("  Daemon instructions.\n"));

    expect(facts).toEqual({
      charsLength: "Daemon instructions.".length,
      hash12: hash12("Daemon instructions."),
    });
  });

  it("records nothing for an unset, empty or whitespace-only setting", async () => {
    for (const value of [undefined, "", "   \n\t "]) {
      expect(await sampleDaemonAppend(reader(value))).toBeNull();
    }
  });

  it("reports an unreadable config as unknown rather than failing the create", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await sampleDaemonAppend(reader(undefined, { throws: new Error("rpc down") }));

    // A before-hook throw would fail the agent creation itself; a missing
    // context row is cosmetic, so the read reports and moves on.
    expect(failed).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("contextKeyOf", () => {
  it("cannot be forged by moving a separator character between values", () => {
    // Plain concatenation would make these two agents share one key.
    expect(contextKeyOf({ provider: "a", cwd: "b", title: "c" })).not.toBe(
      contextKeyOf({ provider: "a/b", cwd: "", title: "c" }),
    );
  });

  it("treats a null and an absent title as the same agent", () => {
    expect(contextKeyOf({ provider: "claude", cwd: "/repo", title: null })).toBe(
      contextKeyOf({ provider: "claude", cwd: "/repo" }),
    );
  });
});

describe("PendingContextQueue", () => {
  const CALLER = { charsLength: 100, hash12: "aaaa0000aaaa" };
  const DAEMON = { charsLength: 20, hash12: "bbbb0000bbbb" };

  it("returns both injections for a matched create, each with its own provenance", () => {
    const queue = new PendingContextQueue();
    queue.stage({ key: "k", caller: CALLER, daemonAppend: DAEMON });

    expect(queue.take({ key: "k" })).toEqual([
      { ...CALLER, source: "caller", correlated: "config" },
      { ...DAEMON, source: "daemon-append", correlated: "time-window" },
    ]);
  });

  it("records a daemon-only injection when the caller configured no prompt", () => {
    const queue = new PendingContextQueue();
    queue.stage({ key: "k", caller: null, daemonAppend: DAEMON });

    expect(queue.take({ key: "k" })).toEqual([
      { ...DAEMON, source: "daemon-append", correlated: "time-window" },
    ]);
  });

  it("records a caller-only injection when the daemon appends nothing", () => {
    const queue = new PendingContextQueue();
    queue.stage({ key: "k", caller: CALLER, daemonAppend: null });

    expect(queue.take({ key: "k" })).toEqual([
      { ...CALLER, source: "caller", correlated: "config" },
    ]);
  });

  it("marks a fallback claim as fifo on the caller row only", () => {
    const queue = new PendingContextQueue();
    queue.stage({ key: "other", caller: CALLER, daemonAppend: DAEMON });

    const rows = queue.take({ key: "unmatched" });
    // The caller prompt is a fallback, so the row must not claim a match. The
    // daemon append is global — there is nothing to match, so it is attributed
    // by the create window either way.
    expect(rows[0]).toEqual({ ...CALLER, source: "caller", correlated: "fifo" });
    expect(rows[1]).toEqual({ ...DAEMON, source: "daemon-append", correlated: "time-window" });
  });

  it("records nothing for a create that injected no context at all", () => {
    const queue = new PendingContextQueue();
    // No caller prompt and no daemon append: stage is a no-op, so the agent's
    // own claim finds an empty queue and produces no rows.
    queue.stage({ key: "k", caller: null, daemonAppend: null });

    expect(queue.size).toBe(0);
    expect(queue.take({ key: "k" })).toEqual([]);
  });

  it("claims each entry once", () => {
    const queue = new PendingContextQueue();
    queue.stage({ key: "k", caller: CALLER, daemonAppend: null });
    expect(queue.take({ key: "k" })).toHaveLength(1);
    expect(queue.take({ key: "k" })).toEqual([]);
  });

  it("bounds the queue, dropping the oldest entry and saying so", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = new PendingContextQueue();
    for (let index = 0; index < MAX_STAGED_CREATES + 5; index += 1) {
      queue.stage({ key: `key-${index}`, caller: CALLER, daemonAppend: null });
    }

    expect(queue.size).toBe(MAX_STAGED_CREATES);
    // The survivors are the newest creates, and a live agent claims the one that
    // matches it by key.
    expect(queue.take({ key: `key-${MAX_STAGED_CREATES + 4}` })).toEqual([
      { ...CALLER, source: "caller", correlated: "config" },
    ]);
    // Drain the rest by key; the five discarded entries leave nothing behind, so
    // a claim for the oldest key falls through to an empty queue rather than
    // picking up a discarded create's rows.
    for (let index = 5; index < MAX_STAGED_CREATES + 4; index += 1) {
      expect(queue.take({ key: `key-${index}` })).toHaveLength(1);
    }
    expect(queue.take({ key: "key-0" })).toEqual([]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
