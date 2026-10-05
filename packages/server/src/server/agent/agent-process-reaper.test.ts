import { describe, expect, test, vi } from "vitest";
import pino from "pino";

import { AGENT_PROCESS_REAP_INTERVAL_MS } from "./agent-process-reaper.js";
import { createAgentProcessReaper } from "./agent-process-reaper.js";
import type { ReapResult } from "./agent-process-registry.js";

const logger = pino({ level: "silent" });

function emptyReap(): ReapResult {
  return { removed: [], kept: [] };
}

describe("agent process reaper scheduling", () => {
  test("runs one pass per interval and stops cleanly", () => {
    vi.useFakeTimers();
    try {
      const reaps: Array<number | undefined> = [];
      const reaper = createAgentProcessReaper({
        logger,
        intervalMs: 1_000,
        budgetMs: 250,
        reap: (budgetMs) => {
          reaps.push(budgetMs);
          return emptyReap();
        },
      });

      reaper.start();
      // start() is idempotent: a second call must not double the cadence.
      reaper.start();
      vi.advanceTimersByTime(3_500);
      expect(reaps).toHaveLength(3);
      // The budget travels with the pass; it is what keeps a stuck entry from
      // blocking the event loop for the whole SIGTERM+SIGKILL window.
      expect(reaps).toEqual([250, 250, 250]);

      reaper.stop();
      vi.advanceTimersByTime(10_000);
      expect(reaps).toHaveLength(3);
      // stop() is idempotent too, so a double-dispose cannot throw.
      reaper.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("never lets two passes overlap", () => {
    vi.useFakeTimers();
    try {
      let running = 0;
      let maxConcurrent = 0;
      let passes = 0;
      const reaper = createAgentProcessReaper({
        logger,
        intervalMs: 100,
        // A "reap" that takes longer than the interval: the timer fires again
        // while the first pass is still inside its wait.
        reap: () => {
          running += 1;
          maxConcurrent = Math.max(maxConcurrent, running);
          passes += 1;
          vi.advanceTimersByTime(500);
          running -= 1;
          return emptyReap();
        },
      });

      reaper.start();
      vi.advanceTimersByTime(2_000);
      // The first pass advanced the clock by 500ms internally; the guard is what
      // stops the next interval from entering the reap concurrently.
      expect(maxConcurrent).toBe(1);
      expect(passes).toBeGreaterThanOrEqual(1);
      reaper.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a throwing pass is contained and does not wedge the timer", () => {
    vi.useFakeTimers();
    try {
      let passes = 0;
      const reaper = createAgentProcessReaper({
        logger,
        intervalMs: 100,
        reap: () => {
          passes += 1;
          if (passes === 1) throw new Error("simulated registry failure");
          return emptyReap();
        },
      });

      reaper.start();
      expect(() => vi.advanceTimersByTime(350)).not.toThrow();
      expect(passes).toBeGreaterThanOrEqual(2);
      reaper.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("runNow executes a pass without starting the timer", () => {
    vi.useFakeTimers();
    try {
      let passes = 0;
      const reaper = createAgentProcessReaper({
        logger,
        intervalMs: 1_000,
        reap: () => {
          passes += 1;
          return emptyReap();
        },
      });
      reaper.runNow();
      expect(passes).toBe(1);
      // No timer was armed, so advancing time must not add passes.
      vi.advanceTimersByTime(60_000);
      expect(passes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the default interval is short against the 24h orphan TTL", () => {
    // A daemon that used to reap only at bootstrap left the orphans of an
    // earlier crash unreaped for the whole TTL plus however long the daemon then
    // stayed up. Five minutes is the bound that removes that.
    expect(AGENT_PROCESS_REAP_INTERVAL_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});
