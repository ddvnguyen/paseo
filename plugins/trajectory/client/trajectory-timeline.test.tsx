/** Gantt strip: lane derivation and rendering (wide + compact). */

// @vitest-environment jsdom
// Expose the act() support flag before react loads; no suppression is needed now
// that the plugin tsconfig resolves real react types.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  StyleSheet: { hairlineWidth: 1 },
  View: ({
    children,
    testID,
    style,
  }: React.PropsWithChildren<{ testID?: string; style?: unknown }>) =>
    React.createElement(
      "div",
      { "data-testid": testID, "data-style": JSON.stringify(style ?? null) },
      children,
    ),
  Text: ({ children, testID }: React.PropsWithChildren<{ testID?: string }>) =>
    React.createElement("span", { "data-testid": testID }, children),
}));

import { deriveTrajectoryLayout } from "../shared/dsh/layout.js";
import type { TrajectoryFoldRow, TrajectoryTurnModel } from "../shared/dsh/layout.js";
import { deriveTrajectoryTimeline } from "../shared/dsh/timeline.js";
import { TrajectoryTimelineStrip } from "./trajectory-timeline.js";
import { FIXTURE_ROWS, FIXTURE_TURN_NUMBERS, FIXTURE_OPEN_CALLS } from "./fixtures.js";

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
};

/** Hoisted so no array literal is created inside a JSX prop. */
const NO_TURNS: readonly TrajectoryTurnModel[] = [];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: { actualDuration?: boolean; compact?: boolean } = {}): void {
  const turns = deriveTrajectoryLayout({
    rows: FIXTURE_ROWS as readonly TrajectoryFoldRow[],
    turnNumbers: FIXTURE_TURN_NUMBERS,
    openCallIds: FIXTURE_OPEN_CALLS,
  });
  act(() => {
    root.render(
      <TrajectoryTimelineStrip
        turns={turns}
        actualDuration={props.actualDuration === true}
        compact={props.compact === true}
        theme={THEME}
      />,
    );
  });
}

function spans(): Element[] {
  return [...container.querySelectorAll('[data-testid^="timeline-span-"]')];
}

/** The component passes `[base, overrides]`, so flatten before reading fields. */
function spanStyle(node: Element): Record<string, unknown> {
  const raw = JSON.parse(node.getAttribute("data-style") ?? "null") as unknown;
  const entries = Array.isArray(raw) ? raw : [raw];
  return Object.assign({}, ...entries.filter((entry): entry is Record<string, unknown> => !!entry));
}

describe("TrajectoryTimelineStrip wiring", () => {
  it("derives a model from the ported layout for the fixture events", () => {
    const turns = deriveTrajectoryLayout({
      rows: FIXTURE_ROWS as readonly TrajectoryFoldRow[],
      turnNumbers: FIXTURE_TURN_NUMBERS,
      openCallIds: FIXTURE_OPEN_CALLS,
    });
    const model = deriveTrajectoryTimeline(turns, "sequence");

    expect(model).not.toBeNull();
    expect(model?.spans.length).toBeGreaterThan(0);
    // Every record lands in exactly one of the three lanes.
    expect(new Set(model?.spans.map((span) => span.lane))).toEqual(new Set([0, 1, 2]));
  });

  it("lays records out at equal width in sequence mode and on the clock in actual mode", () => {
    const turns = deriveTrajectoryLayout({
      rows: FIXTURE_ROWS as readonly TrajectoryFoldRow[],
      turnNumbers: FIXTURE_TURN_NUMBERS,
      openCallIds: FIXTURE_OPEN_CALLS,
    });
    const sequence = deriveTrajectoryTimeline(turns, "sequence");
    const actual = deriveTrajectoryTimeline(turns, "actual");

    // Both projections cover the same records; only the domain differs.
    expect(sequence?.spans.length).toBe(actual?.spans.length);
    expect(sequence?.end).not.toBe(actual?.end);
  });
});

describe("TrajectoryTimelineStrip rendering", () => {
  it("renders the three labelled lanes", () => {
    render();
    for (const key of ["input", "model", "tools"]) {
      expect(container.querySelector(`[data-testid="timeline-lane-${key}"]`)).not.toBeNull();
    }
    expect(container.textContent).toContain("Input");
    expect(container.textContent).toContain("Model");
    expect(container.textContent).toContain("Tools");
  });

  it("renders one bar per record in sequence mode", () => {
    render();
    expect(spans().length).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="trajectory-timeline-mode"]')?.textContent).toBe(
      "sequence",
    );
  });

  it("switches projection when Duration is on", () => {
    render();
    const sequenceSpans = spans().map(spanStyle);

    render({ actualDuration: true });
    expect(container.querySelector('[data-testid="trajectory-timeline-mode"]')?.textContent).toBe(
      "actual time",
    );
    // The bars are re-projected onto the real clock, not just relabelled.
    const actualSpans = spans().map(spanStyle);
    expect(actualSpans).not.toEqual(sequenceSpans);
  });

  it("colours each lane from the theme tokens and marks errors with statusDanger", () => {
    render();
    const styles = spans().map(spanStyle);
    const colors = new Set<string>(styles.map((style) => String(style.backgroundColor)));

    // foregroundMuted (input), accent (model), statusWarning (tools) — and
    // statusDanger only for the fixture's failed tool call.
    expect(colors.has(THEME.colors.foregroundMuted)).toBe(true);
    expect(colors.has(THEME.colors.accent)).toBe(true);
    expect(colors.has(THEME.colors.statusWarning)).toBe(true);
    expect(colors.has(THEME.colors.statusDanger)).toBe(true);
  });

  it("gives every bar a percentage left/width so it can be laid out statically", () => {
    render();
    for (const node of spans()) {
      const style = spanStyle(node);
      expect(typeof style.left).toBe("string");
      expect(String(style.left).endsWith("%")).toBe(true);
      expect(String(style.width).endsWith("%")).toBe(true);
    }
  });

  it("renders nothing when there are no records to project", () => {
    const empty = (
      <TrajectoryTimelineStrip turns={NO_TURNS} actualDuration={false} compact theme={THEME} />
    );
    act(() => {
      root.render(empty);
    });
    expect(container.querySelector('[data-testid="trajectory-timeline"]')).toBeNull();
  });

  it("adapts to the compact layout", () => {
    render({ compact: true });
    expect(spans().length).toBeGreaterThan(0);
  });
});
