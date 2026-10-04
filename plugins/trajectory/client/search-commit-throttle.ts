/**
 * Commit throttle for the search index.
 *
 * Inherited value: dsh uses 3000 ms with a first update immediate and a
 * trailing batch. dsh left no rationale and never tuned it, so this carries
 * the value and not a justification of its own.
 *
 * Scope is deliberately narrow. The index can only serve a FUTURE search, so
 * it is throttled ONLY while no query is active — where the list is unfiltered
 * and cannot inherit this cadence. The moment a query is active the list is
 * filtered by the index's output, so the commit becomes immediate: a throttled
 * commit there would mean a list that filters itself up to 3 s late.
 */

export const SEARCH_COMMIT_THROTTLE_MS = 3000;

export interface CommitThrottle {
  /** Run `commit` now if the interval has elapsed; otherwise defer it to the
   *  trailing edge, replacing any pending batch. */
  request(commit: () => void): void;
  /** Run any deferred commit immediately (unmount, agent change). */
  flush(): void;
  /** Drop a pending batch without running it. */
  cancel(): void;
}

export function createCommitThrottle(
  intervalMs: number,
  now: () => number,
  schedule: (fn: () => void, ms: number) => number,
  clear: (handle: number) => void,
): CommitThrottle {
  let lastCommitAt: number | null = null;
  let pending: number | null = null;
  let pendingCommit: (() => void) | null = null;

  const run = (commit: () => void): void => {
    lastCommitAt = now();
    commit();
  };

  return {
    request(commit) {
      // First commit is immediate: an index with nothing in it cannot answer a
      // query that arrives before the throttle interval.
      if (lastCommitAt === null) {
        run(commit);
        return;
      }
      const elapsed = now() - lastCommitAt;
      if (elapsed >= intervalMs) {
        run(commit);
        return;
      }
      // Trailing edge, collapsing bursts into one commit.
      pendingCommit = commit;
      if (pending !== null) return;
      pending = schedule(() => {
        pending = null;
        const deferred = pendingCommit;
        pendingCommit = null;
        if (deferred !== null) run(deferred);
      }, intervalMs - elapsed);
    },
    flush() {
      if (pending !== null) {
        clear(pending);
        pending = null;
      }
      const deferred = pendingCommit;
      pendingCommit = null;
      if (deferred !== null) run(deferred);
    },
    cancel() {
      if (pending !== null) {
        clear(pending);
        pending = null;
      }
      pendingCommit = null;
    },
  };
}
