import type { Logger } from "pino";

import {
  AGENT_PROCESS_REAP_INTERVAL_BUDGET_MS,
  reapStaleAgentProcesses,
  type ReapResult,
} from "./agent-process-registry.js";

/**
 * How often a long-lived daemon re-runs the registry reap.
 *
 * The reap used to run exactly once, at bootstrap. A daemon that crashed,
 * restarted, and then stayed up for a week therefore left the orphans of every
 * earlier crash unreaped for the whole 24h TTL window plus the week — the bound
 * this feature exists to provide was effectively unbounded. Five minutes is
 * short against a 24h orphan TTL and long enough that the cost is invisible:
 * a pass with nothing expired to do is one `systemctl show` per recorded entry.
 */
export const AGENT_PROCESS_REAP_INTERVAL_MS = 5 * 60_000;

export interface AgentProcessReaper {
  /** Run one pass now (synchronously) and start the periodic timer. */
  start(): void;
  /** Stop the periodic timer. Safe to call more than once. */
  stop(): void;
  /** Run one pass now. Never overlaps itself. */
  runNow(): void;
}

export interface AgentProcessReaperOptions {
  logger?: Logger;
  intervalMs?: number;
  /** Wall-clock budget for each periodic pass, in ms. */
  budgetMs?: number;
  /** Test seam for the reap itself. */
  reap?: (budgetMs: number | undefined) => ReapResult;
}

/**
 * Periodic, bounded re-run of the scoped-child registry reap.
 *
 * Two properties matter here and both are enforced rather than assumed:
 *
 * - The timer is `unref`'d, so a pending reap can never keep a daemon alive.
 * - Each pass gets a wall-clock budget and passes never overlap. The reap is
 *   synchronous and blocks the event loop while it waits out a SIGTERM grace
 *   period, so an unbounded pass would stall websockets and heartbeats; an
 *   entry that cannot be stopped inside the budget keeps its record and is
 *   retried on the next pass.
 */
export function createAgentProcessReaper(
  options: AgentProcessReaperOptions = {},
): AgentProcessReaper {
  const logger = options.logger;
  const intervalMs = options.intervalMs ?? AGENT_PROCESS_REAP_INTERVAL_MS;
  const budgetMs = options.budgetMs ?? AGENT_PROCESS_REAP_INTERVAL_BUDGET_MS;
  const reap =
    options.reap ?? ((passBudgetMs) => reapStaleAgentProcesses({ logger, budgetMs: passBudgetMs }));

  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const runNow = (): void => {
    if (running) {
      logger?.warn(
        { intervalMs },
        "Skipping an agent process reap pass: the previous one is still running",
      );
      return;
    }
    running = true;
    try {
      reap(budgetMs);
    } catch (error) {
      logger?.warn({ err: error }, "Agent process reap pass failed; continuing");
    } finally {
      running = false;
    }
  };

  const start = (): void => {
    if (timer) return;
    timer = setInterval(runNow, intervalMs);
    // A reaper is maintenance, not work: it must never hold the process open.
    timer.unref();
  };

  const stop = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  return { start, stop, runNow };
}
