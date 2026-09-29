/**
 * The real list, under jsdom, against react-native-web.
 *
 * Every other client test in this plugin mocks `react-native` wholesale and
 * swaps FlatList for a `data.map` stand-in that renders every row, so the real
 * VirtualizedList has never run here. That is a separate vitest PROJECT rather
 * than a second `resolve.alias` on the default one: the alias is global, and
 * changing it would break the six mocks. See vitest.config.ts.
 *
 * What this file can and cannot prove
 * -----------------------------------
 * CAN: that the first paint is bounded by `initialNumToRender` and does not
 * grow with history size. `listrow-${row.key}` exists for exactly this — a
 * mounted-row count taken from a `data.map` mock is worthless.
 *
 * CANNOT: anything about the real window. Under jsdom the vendored
 * VirtualizedList returns early while `visibleLength`/`contentLength` are 0
 * (VirtualizedList/index.js:810-812) and jsdom never sets them, so there is no
 * scroll metric to window against. Real windowing, geometry drift, and
 * anchor stability across a prepend need a browser and belong to S3e's gated
 * half. Read a failure here as "the first paint changed", never as "windowing
 * is broken".
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LedgerScreen } from "./ledger-screen.js";
import { scaleRows } from "../shared/dsh/scale-fixture.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const THEME = {
  colors: {
    surface0: "#000",
    surface1: "#111",
    surface2: "#222",
    border: "#333",
    foreground: "#fff",
    foregroundMuted: "#aaa",
    accent: "#0af",
    accentForeground: "#fff",
    statusSuccess: "#0f0",
    statusWarning: "#ff0",
    statusDanger: "#f00",
  },
} as never;

/** Must match ledger-screen.tsx's initialNumToRender. */
const INITIAL_NUM_TO_RENDER = 24;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * Count what the real list actually mounted. Every row kind carries a testID:
 * cell rows as `listrow-<key>` (added in S3), chrome as its own ids. A count
 * from the stand-in's `data.map` would be the full data length and would prove
 * nothing.
 */
function mountedRows(): number {
  return document.querySelectorAll(
    '[data-testid^="listrow-"], [data-testid^="turn-header-"], [data-testid^="step-header-"], [data-testid="turn-rule"]',
  ).length;
}

function mountedCellRows(): number {
  return document.querySelectorAll('[data-testid^="listrow-"]').length;
}

/**
 * Mount the ledger with `turns` turns and unfold everything, so the data
 * contains cell rows and not just collapsed headers.
 */
function mountLedger(turns: number): { cellRows: number; mounted: number } {
  // Tear the previous screen down first. afterEach only runs after the test,
  // so mounting a second one without this leaves the first mounted and every
  // count silently doubles — which reads as "the window grew with N".
  if (container !== undefined) {
    act(() => root.unmount());
    container.remove();
  }
  container = document.createElement("div");
  // PINNED. An unconstrained container is the inverse blind spot: the list grows
  // to fit its content, every row is "visible", and that reads as windowing
  // working. In a real browser this is what bounds the window; under jsdom the
  // bound comes from initialNumToRender instead, because the scroll metrics are
  // 0. Pinned anyway, so the spec matches the browser it will eventually run in.
  container.style.height = "800px";
  container.style.width = "390px";
  document.body.appendChild(container);
  root = createRoot(container);

  const rows = scaleRows(turns, 4);
  act(() => {
    root.render(<LedgerScreen rows={rows} compact={false} theme={THEME} />);
  });
  // One press opens every turn and step, so cell rows enter the window.
  act(() => {
    (document.querySelector('[data-testid="toggle-turns"]') as HTMLButtonElement).click();
  });
  return { cellRows: mountedCellRows(), mounted: mountedRows() };
}

describe("ledger window (real react-native-web VirtualizedList)", () => {
  it("mounts a bounded window that does not grow with history size", () => {
    const small = mountLedger(200);
    // N vs 4N. Independence is the claim; the ceiling alone would pass for an
    // accidentally tiny render and for an accidentally huge one.
    const large = mountLedger(800);

    // Both are non-zero, so independence cannot be satisfied by 0 == 0.
    expect({
      smallMounted: small.mounted,
      largeMounted: large.mounted,
      smallCellRows: small.cellRows,
      largeCellRows: large.cellRows,
    }).toEqual({
      smallMounted: large.mounted,
      largeMounted: large.mounted,
      smallCellRows: small.cellRows,
      largeCellRows: large.cellRows,
    });

    // The bound. initialNumToRender is the only windowing input under jsdom, so
    // the first paint cannot exceed it.
    expect(small.mounted).toBeLessThanOrEqual(INITIAL_NUM_TO_RENDER);
    expect(large.mounted).toBeLessThanOrEqual(INITIAL_NUM_TO_RENDER);
    // And the window is real rows, not an empty list that trivially "fits".
    expect(small.mounted).toBeGreaterThan(0);
    expect(small.cellRows).toBeGreaterThan(0);
  });
});
