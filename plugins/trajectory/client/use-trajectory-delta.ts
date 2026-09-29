import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import type { TrajectoryFoldRow } from "../shared/dsh/layout.js";
import {
  TRAJECTORY_PAGE_LIMIT_DEFAULT,
  trajectoryChanges,
  trajectoryList,
  type TrajectoryEvent,
} from "../shared/trajectory.js";
import { eventsToFoldRows } from "./events-to-rows.js";

export type TrajectoryDelta =
  | { status: "loading"; rows: TrajectoryFoldRow[]; headSeq: number }
  | { status: "live"; rows: TrajectoryFoldRow[]; headSeq: number }
  | { status: "error"; error: string; rows: TrajectoryFoldRow[]; headSeq: number };

/**
 * Page size for a load-older read. Matches the list schema's default so a page
 * that comes back short is unambiguous: fewer rows than this means the end of
 * history, because `list` hands back the newest rows below the cursor.
 */
const LOAD_OLDER_PAGE_LIMIT = TRAJECTORY_PAGE_LIMIT_DEFAULT;

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
  /**
   * Read the page of events older than the oldest buffered one and prepend it.
   * No-op while a read is in flight, so a burst of presses fetches once.
   */
  loadOlder: () => void;
  /** True while a read is in flight. */
  loadingOlder: boolean;
  /**
   * False once a read came back short of a full page, which is how an exhausted
   * ledger is known. True is not a promise of history — it means "worth asking".
   */
  hasOlderHistory: boolean;
} {
  const list = useRpc(trajectoryList);
  const changes = useRpc(trajectoryChanges);
  const [delta, setDelta] = useState<TrajectoryDelta>(() => ({
    status: "loading",
    rows: [],
    headSeq: 0,
  }));
  const kickRef = useRef<(() => void) | null>(null);
  const loadOlderRef = useRef<(() => void) | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlderHistory, setHasOlderHistory] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const buffer: TrajectoryEvent[] = [];
    let headSeq = 0;
    let firstPage = true;
    let frame: { cancel: () => void } | null = null;
    // A separate lock from the drain's `inFlight`: a load-older read and a
    // forward drain are different queries, and the affordance is pressed by
    // hand, so only the affordance's own re-entry has to be blocked.
    let olderInFlight = false;
    // Epoch guards the frame gate: a flush scheduled before an error (or a
    // reload) must not clobber the newer status when its timer fires. Every
    // non-flush setDelta bumps the epoch; flush applies only on a match.
    let epoch = 0;

    epoch += 1;
    // A new agent starts with unknown history: the flag is an answer to a
    // question only a read can settle.
    setHasOlderHistory(true);
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

    /**
     * Prepend the next older page. `beforeSeq` is exclusive, so it is the
     * oldest seq already buffered — the row immediately above the window.
     * Older events go to the FRONT of the buffer, keeping it ascending, which
     * is what eventsToFoldRows requires (it walks in arrival order and never
     * sorts).
     */
    loadOlderRef.current = () => {
      if (cancelled || olderInFlight) return;
      const oldest = buffer[0]?.seq;
      // Nothing buffered, so there is no cursor to page back from.
      if (oldest === undefined) return;
      olderInFlight = true;
      setLoadingOlder(true);
      void (async () => {
        try {
          const page = await list({ agentId, beforeSeq: oldest });
          if (cancelled) return;
          // A short page means the ledger ends here. `list` returns the NEWEST
          // rows below the cursor, so a page under the limit is the end of
          // history, not a gap.
          if (page.events.length < LOAD_OLDER_PAGE_LIMIT) setHasOlderHistory(false);
          // Prepend only what is genuinely older, so a concurrent append can
          // never produce duplicates or an out-of-order buffer.
          const older = page.events.filter((event) => event.seq < oldest);
          if (older.length === 0) setHasOlderHistory(false);
          buffer.unshift(...older);
          // Fold immediately rather than through the frame gate: the affordance
          // is waiting on this to restore its scroll anchor.
          epoch += 1;
          setDelta({ status: "live", rows: eventsToFoldRows(buffer), headSeq });
        } catch (error) {
          if (cancelled) return;
          setDelta({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            rows: eventsToFoldRows(buffer),
            headSeq,
          });
        } finally {
          olderInFlight = false;
          if (!cancelled) setLoadingOlder(false);
        }
      })();
    };
    void loop();

    return () => {
      cancelled = true;
      kickRef.current = null;
      loadOlderRef.current = null;
      frame?.cancel();
      frame = null;
    };
  }, [agentId, list, changes]);

  const refresh = useCallback(() => {
    kickRef.current?.();
  }, []);

  const loadOlder = useCallback(() => {
    loadOlderRef.current?.();
  }, []);

  return { ...delta, refresh, loadOlder, loadingOlder, hasOlderHistory };
}
