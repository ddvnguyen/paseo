import { useEffect, useState } from "react";

/**
 * Wall-clock now, re-read once a second, but only while something is running.
 *
 * A settled ledger never needs a clock: its rows carry their own durations, and
 * a timer that fires forever would re-render every visible row for nothing. So
 * the caller passes `live` and pays nothing when it is false — no interval, no
 * state, no render.
 *
 * `null` while not live, so a caller cannot accidentally render "0 ms" from an
 * unsampled clock: it has to decide what to show instead.
 *
 * @param live Whether anything on screen is still running.
 * @param intervalMs Tick period; 1s reads as "still going" without churning.
 * @returns Epoch ms at the last tick, or null when not live.
 */
export function useLiveElapsedMs(live: boolean, intervalMs = 1_000): number | null {
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    if (!live) {
      setNowMs(null);
      return;
    }
    // Sample immediately so the first paint after `live` turns true already has
    // a clock instead of waiting a full tick to leave the em dash behind.
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [live, intervalMs]);

  return nowMs;
}

/**
 * A row's own running time in MILLISECONDS, live while the row is open.
 *
 * Milliseconds, not seconds: every consumer downstream formats milliseconds (the
 * ledger's duration tiers, dsh's ms formatter), so a seconds return would put a
 * factor of 1000 between two adjacent lines and make "5 ms" out of five seconds.
 *
 * A settled row shows its recorded own duration (null = unknown = the dsh em
 * dash). An OPEN row has no end yet, so the honest number is the time since it
 * started — and it is the only case where the clock is consulted.
 *
 * @param open Whether the row is still running.
 * @param startedAt Epoch ms the row started, when known.
 * @param recordedMs The row's own recorded duration, when settled.
 * @returns Milliseconds, or null when neither a live clock nor a duration exists.
 */
export function useRowElapsedMs(input: {
  open: boolean;
  startedAt: number | null | undefined;
  recordedMs: number | null;
}): number | null {
  const { open, startedAt, recordedMs } = input;
  const nowMs = useLiveElapsedMs(open && typeof startedAt === "number");
  if (!open || nowMs === null || typeof startedAt !== "number") return recordedMs;
  const elapsed = nowMs - startedAt;
  // A clock that reads behind the row's start (clock skew between the daemon and
  // this device) must not produce a negative duration in a column of positives.
  return Math.max(0, elapsed);
}
