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
 * How long an OPEN row has been running, in MILLISECONDS, or null when it is not
 * open.
 *
 * There is deliberately no "settled duration" input: a settled row's duration is
 * a recorded measurement and belongs to whoever recorded it. This hook answers
 * one question — "how long has the thing still running been running" — and it is
 * the only place in the plugin that reads a clock, so there is exactly one rule
 * about when that is allowed: never for a row that has already ended.
 *
 * Milliseconds, because that is the unit every duration formatter downstream
 * takes. A seconds return would put a factor of 1000 between this and
 * `formatDurationMillis`, and "5 ms" out of five seconds is the kind of bug that
 * survives review because it looks like a rounding.
 *
 * @param open Whether the row is still running.
 * @param startedAt Epoch ms the row started, when known.
 * @returns Elapsed ms, or null when the row is not open or never started.
 */
export function useOpenElapsedMs(
  open: boolean,
  startedAt: number | null | undefined,
): number | null {
  const nowMs = useLiveElapsedMs(open && typeof startedAt === "number");
  if (!open || nowMs === null || typeof startedAt !== "number") return null;
  // A viewer clock behind the daemon's stamp must not produce a negative
  // duration in a column of positives.
  return Math.max(0, nowMs - startedAt);
}
