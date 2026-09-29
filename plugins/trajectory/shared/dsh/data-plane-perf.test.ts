/**
 * Data-plane scaling ceiling.
 *
 * Ratios, never absolute milliseconds: shared CI hardware is 2-3x slower than
 * any single machine, so a millisecond budget is a flaky test. Every
 * assertion is t(4N)/t(N) against a baseline measured in the SAME run, and the
 * bound is set from what the shape can be, not from what it happens to be.
 *
 * Two axes, because they find different things:
 * - a size ladder (turns grow, steps fixed) holds a ceiling on paths that are
 *   already linear;
 * - a degenerate axis (steps grow within ONE turn) is the only thing that
 *   reaches the per-turn group lookup, which is quadratic in steps. A pure
 *   size ladder structurally cannot see it.
 */

import { describe, expect, test } from "vitest";
import { eventsToFoldRows } from "../../client/events-to-rows.js";
import { deriveTrajectoryLayout } from "./layout.js";
import { scaleEvents, scaleRows, turnNumbersFor } from "./scale-fixture.js";
import { TrajectorySearchIndex } from "./search-index.js";
import { groupTrajectoryVirtualRows } from "./virtual-rows.js";

/** Best of N, so one GC pause cannot read as a scaling failure. */
function best<T>(run: () => T, repeats = 3): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < repeats; i++) {
    const start = process.hrtime.bigint();
    run();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (ms < lowest) lowest = ms;
  }
  return lowest;
}

const layoutFor = (turns: number, density: number) => {
  const rows = scaleRows(turns, density);
  return deriveTrajectoryLayout({ rows, turnNumbers: turnNumbersFor(rows) });
};

const cellsOf = (layout: ReturnType<typeof layoutFor>) =>
  layout.flatMap((turn) => turn.groups.flatMap((group) => group.cells.map((cell) => ({ cell }))));

describe("data-plane scaling", () => {
  // 4x the work must not cost more than 8x the time. Linear would be ~4x; the
  // slack absorbs noise and GC without admitting a quadratic (which would be
  // ~16x).
  const LINEAR = 8;

  test("deriveTrajectoryLayout scales linearly with turn count", () => {
    for (const density of [1, 4]) {
      const small = best(() => layoutFor(400, density));
      const large = best(() => layoutFor(1600, density));
      expect(large / small).toBeLessThan(LINEAR);
    }
  });

  test("deriveTrajectoryLayout scales linearly in steps WITHIN one turn", () => {
    // The axis a size ladder cannot reach. deriveTrajectoryLayout looked a turn's
    // group up with groups.find() per step row, which is quadratic in steps:
    // measured 3.12 / 9.39 / 24.03 / 68.68 ms at 500 / 1000 / 2000 / 4000
    // steps, per-doubling ratios of ~3.
    const small = best(() => layoutFor(1, 500));
    const large = best(() => layoutFor(1, 2000));
    expect(large / small).toBeLessThan(LINEAR);
  });

  test("the virtual-row projection scales linearly", () => {
    for (const density of [1, 4]) {
      const smallLayout = layoutFor(400, density);
      const largeLayout = layoutFor(1600, density);
      const small = best(() => groupTrajectoryVirtualRows(cellsOf(smallLayout)));
      const large = best(() => groupTrajectoryVirtualRows(cellsOf(largeLayout)));
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
    const small = best(() => eventsToFoldRows(scaleEvents(400, 1)));
    const large = best(() => eventsToFoldRows(scaleEvents(1600, 1)));
    expect(large / small).toBeLessThan(LINEAR);
  });
});
