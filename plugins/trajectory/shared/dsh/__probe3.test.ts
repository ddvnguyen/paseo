// @vitest-environment jsdom
import { test } from "vitest";
import { deriveTrajectoryLayout } from "./layout.js";
import { scaleRows, turnNumbersFor } from "./scale-fixture.js";
import { TrajectorySearchIndex } from "./search-index.js";
const ms = (n: bigint) => Number(n) / 1e6;
const best = (fn: () => unknown, n = 3) => {
  let lo = Infinity;
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    fn();
    const d = ms(process.hrtime.bigint() - t);
    if (d < lo) lo = d;
  }
  return lo;
};
test("keystroke path", { timeout: 600000 }, () => {
  const rows = scaleRows(1600, 1);
  const turns = deriveTrajectoryLayout({ rows, turnNumbers: turnNumbersFor(rows) });
  const cells = turns.reduce((n, t) => n + t.groups.reduce((m, g) => m + g.cells.length, 0), 0);
  const idx = new TrajectorySearchIndex();
  idx.update([turns]);
  const fresh = best(() => idx.update([turns]));
  const stable = [turns];
  const reused = best(() => idx.update(stable));
  console.log(`\ncells=${cells}`);
  console.log(`update with a FRESH wrapper [turns] each call : ${fresh.toFixed(3)} ms`);
  console.log(`update with a STABLE wrapper reused         : ${reused.toFixed(4)} ms`);
  console.log(
    `short-circuit saves                          : ${(fresh / Math.max(reused, 1e-6)).toFixed(0)}x`,
  );
});
