import { describe, expect, it, vi } from "vitest";
import { createCommitThrottle, SEARCH_COMMIT_THROTTLE_MS } from "./search-commit-throttle.js";

/** A hand-driven clock, so the throttle is tested without waiting on real time. */
function harness(start = 0) {
  let clock = start;
  const scheduled: { at: number; fn: () => void; handle: number }[] = [];
  let nextHandle = 1;
  const throttle = createCommitThrottle(
    SEARCH_COMMIT_THROTTLE_MS,
    () => clock,
    (fn, ms) => {
      const handle = nextHandle++;
      scheduled.push({ at: clock + ms, fn, handle });
      return handle;
    },
    (handle) => {
      const index = scheduled.findIndex((entry) => entry.handle === handle);
      if (index >= 0) scheduled.splice(index, 1);
    },
  );
  return {
    throttle,
    advance(ms: number) {
      clock += ms;
      for (const entry of scheduled.slice()) {
        if (entry.at <= clock) {
          scheduled.splice(scheduled.indexOf(entry), 1);
          entry.fn();
        }
      }
    },
    pending: () => scheduled.length,
  };
}

describe("search commit throttle", () => {
  it("commits the first request immediately", () => {
    const { throttle } = harness();
    const commit = vi.fn();
    throttle.request(commit);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("defers a burst inside the interval and collapses it to one commit", () => {
    const { throttle, advance, pending } = harness();
    const commit = vi.fn();
    throttle.request(commit);
    expect(commit).toHaveBeenCalledTimes(1);

    // A burst of appends, each asking to commit.
    for (let i = 0; i < 5; i++) throttle.request(commit);
    expect({ commits: commit.mock.calls.length, pendingTimers: pending() }).toEqual({
      commits: 1,
      pendingTimers: 1,
    });

    advance(SEARCH_COMMIT_THROTTLE_MS);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("commits immediately once the interval has elapsed", () => {
    const { throttle, advance } = harness();
    const commit = vi.fn();
    throttle.request(commit);
    advance(SEARCH_COMMIT_THROTTLE_MS + 1);
    throttle.request(commit);
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it("carries the latest request, not the first, to the trailing edge", () => {
    const { throttle, advance } = harness();
    throttle.request(() => {});
    const first = vi.fn();
    const last = vi.fn();
    throttle.request(first);
    throttle.request(last);
    advance(SEARCH_COMMIT_THROTTLE_MS);
    expect({ first: first.mock.calls.length, last: last.mock.calls.length }).toEqual({
      first: 0,
      last: 1,
    });
  });

  it("cancel drops the pending batch without running it", () => {
    const { throttle, pending } = harness();
    throttle.request(() => {});
    const deferred = vi.fn();
    throttle.request(deferred);
    throttle.cancel();
    expect({ ran: deferred.mock.calls.length, pendingTimers: pending() }).toEqual({
      ran: 0,
      pendingTimers: 0,
    });
  });
});
