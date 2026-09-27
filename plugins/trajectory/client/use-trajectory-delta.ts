import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { TrajectoryFoldRow } from "../shared/dsh/layout.js";
import { trajectoryChanges, trajectoryList, type TrajectoryEvent } from "../shared/trajectory.js";
import { eventsToFoldRows } from "./events-to-rows.js";

export type TrajectoryDelta =
  | { status: "loading"; rows: TrajectoryFoldRow[]; headSeq: number }
  | { status: "live"; rows: TrajectoryFoldRow[]; headSeq: number }
  | { status: "error"; error: string; rows: TrajectoryFoldRow[]; headSeq: number };

/**
 * Live ledger feed (T2.4 delta loop, locked design):
 * - `trajectory.list` once for the initial window,
 * - then `trajectory.changes(afterSeq=headSeq)` re-fired on settle while a
 *   response carried events (drain), parked on an empty page until kicked.
 * - No interval timers. Kicks: mount, agent change, manual `refresh()`.
 * - Rows reach state through one per-frame gate (rAF on web, timeout on
 *   native) so a burst of settled pages folds once; the cursor advances on
 *   receipt, independent of the frame gate.
 * - `trajectory.subscribe` is payload-identical to `changes` (T1 seam), so a
 *   future push transport swaps the `changes` call without touching the fold.
 */
export function useTrajectoryDelta(agentId: string): TrajectoryDelta & {
  refresh: () => void;
} {
  const list = useRpc(trajectoryList);
  const changes = useRpc(trajectoryChanges);
  const [delta, setDelta] = useState<TrajectoryDelta>(() => ({
    status: "loading",
    rows: [],
    headSeq: 0,
  }));
  const kickRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const buffer: TrajectoryEvent[] = [];
    let headSeq = 0;
    let firstPage = true;
    let frame: { cancel: () => void } | null = null;
    // Epoch guards the frame gate: a flush scheduled before an error (or a
    // reload) must not clobber the newer status when its timer fires. Every
    // non-flush setDelta bumps the epoch; flush applies only on a match.
    let epoch = 0;

    epoch += 1;
    setDelta({ status: "loading", rows: [], headSeq: 0 });

    const flush = (ticket: number) => {
      frame = null;
      if (cancelled || ticket !== epoch) return;
      const rows = eventsToFoldRows(buffer);
      setDelta({ status: "live", rows, headSeq });
    };

    const scheduleFlush = () => {
      if (frame !== null || cancelled) return;
      const ticket = epoch;
      if (Platform.OS === "web" && typeof requestAnimationFrame === "function") {
        const id = requestAnimationFrame(() => flush(ticket));
        frame = {
          cancel: () => cancelAnimationFrame(id),
        };
      } else {
        const id = setTimeout(() => flush(ticket), 0);
        frame = {
          cancel: () => clearTimeout(id),
        };
      }
    };

    const loop = async (): Promise<void> => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        for (;;) {
          const page =
            buffer.length === 0 && headSeq === 0
              ? await list({ agentId })
              : await changes({ agentId, afterSeq: headSeq });
          if (cancelled) return;
          headSeq = page.headSeq;
          if (page.events.length === 0) {
            // Park until the next kick. The first page resolves the initial
            // loading state even when the ledger is still empty.
            if (firstPage) {
              firstPage = false;
              setDelta({ status: "live", rows: [], headSeq });
            }
            return;
          }
          firstPage = false;
          buffer.push(...page.events);
          scheduleFlush();
        }
        // Unreachable: the loop returns on empty pages, errors, or cancel.
        // No timers, no hot loop — kicks come from mount/agent change/refresh.
      } catch (error) {
        if (cancelled) return;
        epoch += 1;
        setDelta({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          rows: eventsToFoldRows(buffer),
          headSeq,
        });
      } finally {
        inFlight = false;
      }
    };

    kickRef.current = () => {
      void loop();
    };
    void loop();

    return () => {
      cancelled = true;
      kickRef.current = null;
      frame?.cancel();
      frame = null;
    };
  }, [agentId, list, changes]);

  const refresh = useCallback(() => {
    kickRef.current?.();
  }, []);

  return { ...delta, refresh };
}
