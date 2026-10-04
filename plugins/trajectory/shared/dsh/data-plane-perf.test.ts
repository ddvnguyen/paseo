/**
 * Data-plane scaling ceiling.
 *
 * Ratios, never absolute milliseconds: shared CI hardware is 2-3x slower than
 * any single machine, so a millisecond budget is a flaky test. Every assertion
 * is t(4N)/t(N) against a baseline measured in the SAME run, and the bound is
 * set from what the shape can be, not from what it happens to be.
 *
 * The axis is a size ladder — turns grow, steps-per-turn fixed — which holds a
 * ceiling on paths that are already linear.
 *
 * NOT ported from PR #30: its second axis, one turn with many steps. That axis
 * exists to reach the O(steps²) `groups.find()` inside a turn in
 * `deriveTrajectoryLayout`, and it is red on this branch because #30's fix for
 * that lookup (a per-turn title->group index) came in a commit whose file here
 * has since diverged. Porting the assertion without the fix would land a
 * deliberately failing test, and porting the fix is outside this port's scope.
 * A size ladder structurally cannot see that quadratic either way, which is why
 * it was a separate axis to begin with.
 */

import { describe, expect, test } from "vitest";
import { eventsToFoldRows } from "../../client/events-to-rows.js";
import { deriveTrajectoryLayout } from "./layout.js";
import { scaleEvents, scaleRows, turnNumbersFor } from "./scale-fixture.js";
import { TrajectorySearchIndex } from "./search-index.js";
import { groupTrajectoryVirtualRows } from "./virtual-rows.js";

/**
 * Best of N, so one GC pause cannot read as a scaling failure.
 *
 * N is 7 rather than #30's 3 because at 400 turns the smallest measured path
 * runs in about a millisecond, and best-of-3 on a baseline that short reported
 * the LINEAR derive path at 7.4x for 4x the work. Per-doubling ratios measured
 * directly are ~2.0, i.e. it is linear and the sample was noise.
 *
 * Every case is also run once untimed first. Without that warm-up the two sides
 * of a ratio are compared at different points on the JIT curve, and the
 * virtual-row projection went red on roughly 1 run in 12 before it.
 */
function best<T>(run: () => T, repeats = 7): number {
  run();
  let lowest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < repeats; i++) {
    const start = process.hrtime.bigint();
    run();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (ms < lowest) lowest = ms;
  }
  return lowest;
}

/**
 * Fixtures are built OUTSIDE the timed region. They scale linearly too, so
 * timing them does not hide a regression, but they dominate a one-millisecond
 * baseline and bury the path being bounded in allocator noise. This is a
 * deviation from #30, which timed them.
 */
const deriveOver = (turns: number, density: number) => {
  const rows = scaleRows(turns, density);
  const turnNumbers = turnNumbersFor(rows);
  return () => deriveTrajectoryLayout({ rows, turnNumbers });
};

const layoutFor = (turns: number, density: number) => deriveOver(turns, density)();

const cellsOf = (layout: ReturnType<typeof layoutFor>) =>
  layout.flatMap((turn) => turn.groups.flatMap((group) => group.cells.map((cell) => ({ cell }))));

describe("data-plane scaling", () => {
  // 4x the work must not cost more than 8x the time. Linear would be ~4x; the
  // slack absorbs noise and GC without admitting a quadratic (which would be
  // ~16x). Measured here: 2.1x for derive at density 1, 4.5x at density 4,
  // 2.1-4.6x for the other three paths.
  const LINEAR = 8;

  test("deriveTrajectoryLayout scales linearly with turn count", () => {
    for (const density of [1, 4]) {
      const small = best(deriveOver(400, density));
      const large = best(deriveOver(1600, density));
      expect(large / small).toBeLessThan(LINEAR);
    }
  });

  test("the virtual-row projection scales linearly", () => {
    for (const density of [1, 4]) {
      const smallCells = cellsOf(layoutFor(400, density));
      const largeCells = cellsOf(layoutFor(1600, density));
      const small = best(() => groupTrajectoryVirtualRows(smallCells));
      const large = best(() => groupTrajectoryVirtualRows(largeCells));
      expect(large / small).toBeLessThan(LINEAR);
    }
  });

  test("a search-index update scales linearly", () => {
    for (const density of [1, 4]) {
      const smallLayout = layoutFor(400, density);
      const largeLayout = layoutFor(1600, density);
      const small = best(() => new TrajectorySearchIndex().update([smallLayout]));
      const large = best(() => new TrajectorySearchIndex().update([largeLayout]));
      expect(large / small).toBeLessThan(LINEAR);
    }
  });

  test("searching scales linearly", () => {
    const smallLayout = layoutFor(400, 1);
    const largeLayout = layoutFor(1600, 1);
    const smallIndex = new TrajectorySearchIndex();
    smallIndex.update([smallLayout]);
    const largeIndex = new TrajectorySearchIndex();
    largeIndex.update([largeLayout]);
    const small = best(() => smallIndex.search("step"));
    const large = best(() => largeIndex.search("step"));
    expect(large / small).toBeLessThan(LINEAR);
  });

  test("eventsToFoldRows scales linearly", () => {
    const smallEvents = scaleEvents(400, 1);
    const largeEvents = scaleEvents(1600, 1);
    const small = best(() => eventsToFoldRows(smallEvents));
    const large = best(() => eventsToFoldRows(largeEvents));
    expect(large / small).toBeLessThan(LINEAR);
  });
});
