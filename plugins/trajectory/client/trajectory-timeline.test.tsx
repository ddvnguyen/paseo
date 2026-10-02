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
    onPointerEnter,
    onPointerLeave,
  }: React.PropsWithChildren<{
    testID?: string;
    style?: unknown;
    onPointerEnter?: () => void;
    onPointerLeave?: () => void;
  }>) =>
    React.createElement(
      "div",
      {
        "data-testid": testID,
        "data-style": JSON.stringify(style ?? null),
        onPointerEnter,
        onPointerLeave,
      },
      children,
    ),
  Text: ({ children, testID }: React.PropsWithChildren<{ testID?: string }>) =>
    React.createElement("span", { "data-testid": testID }, children),
  // The bar is a Pressable inside the hover-tracking View (docs/hover.md), so
  // the mock has to carry press, disabled and the accessibility props.
  Pressable: ({
    children,
    onPress,
    testID,
    style,
    disabled,
    accessibilityLabel,
    accessibilityState,
  }: React.PropsWithChildren<{
    onPress?: () => void;
    testID?: string;
    style?: unknown;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
  }>) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        // The bar's own geometry lives on the Pressable, so the style has to be
        // observable here too or the projection assertions read nothing.
        "data-style": JSON.stringify(style ?? null),
        "data-disabled": disabled === true ? "1" : "0",
        "data-selected": accessibilityState?.selected === true ? "1" : "0",
        "aria-label": accessibilityLabel,
        disabled: disabled === true,
        onClick: disabled === true ? undefined : onPress,
      },
      children,
    ),
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

function render(
  props: {
    actualDuration?: boolean;
    compact?: boolean;
    platform?: "ios" | "android" | "web";
    selectedSeq?: number | null;
    onSelectSpan?: (sourceSeq: number) => void;
  } = {},
): void {
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
        platform={props.platform}
        selectedSeq={props.selectedSeq}
        onSelectSpan={props.onSelectSpan}
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

  // --- T3-C: tooltip, selection highlight, tap-to-detail ------------------

  /** A selection spy built outside any JSX scope (react-perf). */
  function collector(): { picked: number[]; record: (sourceSeq: number) => void } {
    const picked: number[] = [];
    return { picked, record: (sourceSeq: number) => void picked.push(sourceSeq) };
  }

  it("shows no tooltip until a bar is hovered or pressed", () => {
    render({ platform: "web" });
    expect(container.querySelector('[data-testid="timeline-tooltip"]')).toBeNull();
  });

  it("opens the tooltip on hover on web, with kind, label and duration", () => {
    render({ platform: "web" });
    const target = spans()[0];
    const envelope = container.querySelector(
      `[data-testid="timeline-hover-${target.getAttribute("data-testid")?.replace("timeline-span-", "")}"]`,
    );
    act(() => {
      // React's onPointerEnter is driven by the bubbling pointerover/out pair.
      envelope?.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    const tooltip = container.querySelector('[data-testid="timeline-tooltip"]');
    expect(tooltip).not.toBeNull();
    // Kind, the record's own label, and a duration from the ported formatter.
    expect(container.querySelector('[data-testid="timeline-tooltip-kind"]')?.textContent).toMatch(
      /message|user|tool/,
    );
    expect(
      container.querySelector('[data-testid="timeline-tooltip-label"]')?.textContent?.length,
    ).toBeGreaterThan(0);
    // The shared formatter's three tiers, or the em dash for an open span: the
    // tooltip must not be left showing a raw millisecond count.
    expect(
      container.querySelector('[data-testid="timeline-tooltip-duration"]')?.textContent,
    ).toMatch(/^(?:\d+ ms|\d+s|\d+m\d+s|—)$/);
  });

  it("does not open on hover when the surface is not web", () => {
    // Native has no hover at all, so the hover path must stay inert there and
    // the tooltip has to be reachable by tap instead.
    render({ platform: "ios" });
    const envelope = container.querySelector('[data-testid^="timeline-hover-"]');
    act(() => {
      // React's onPointerEnter is driven by the bubbling pointerover/out pair.
      envelope?.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="timeline-tooltip"]')).toBeNull();
  });

  it("opens the tooltip on tap and toggles it off on a second tap", () => {
    render({ platform: "ios" });
    const target = spans()[0] as HTMLButtonElement;
    act(() => target.click());
    expect(container.querySelector('[data-testid="timeline-tooltip"]')).not.toBeNull();
    act(() => target.click());
    expect(container.querySelector('[data-testid="timeline-tooltip"]')).toBeNull();
  });

  it("moves the tooltip to another bar on tap", () => {
    render({ platform: "web" });
    const [first, second] = spans() as HTMLButtonElement[];
    act(() => first.click());
    const afterFirst = container.querySelector(
      '[data-testid="timeline-tooltip-label"]',
    )?.textContent;
    act(() => second.click());
    const afterSecond = container.querySelector(
      '[data-testid="timeline-tooltip-label"]',
    )?.textContent;
    expect(afterSecond).not.toBe(afterFirst);
  });

  it("outlines the selected record's bar and leaves the rest alone", () => {
    render();
    const target = spans()[0];
    const key = target.getAttribute("data-testid")?.replace("timeline-span-", "");
    render({ platform: "web", selectedSeq: FIXTURE_ROWS[0].seq });
    const selected = container.querySelector(`[data-testid="timeline-span-${key}"]`);
    expect(spanStyle(selected as Element).borderColor).toBe(THEME.colors.accent);
    // Unselected bars carry no outline.
    for (const node of spans().filter((n) => n !== selected)) {
      expect(spanStyle(node).borderColor).toBeUndefined();
    }
  });

  it("outlines nothing when no row is selected", () => {
    render({ platform: "web", selectedSeq: null });
    for (const node of spans()) {
      expect(spanStyle(node).borderColor).toBeUndefined();
    }
  });

  it("keeps a failed record reading as statusDanger while selected", () => {
    const errorRow = FIXTURE_ROWS.find((row) => row.isError === true);
    if (errorRow === undefined) throw new Error("fixture has no error row");
    render({ platform: "web", selectedSeq: errorRow.seq });
    const danger = spans().filter(
      (node) => spanStyle(node).backgroundColor === THEME.colors.statusDanger,
    );
    expect(danger.length).toBeGreaterThan(0);
    // The selection outline is an addition, never a replacement of the failure.
    for (const node of danger) {
      const style = spanStyle(node);
      expect(style.backgroundColor).toBe(THEME.colors.statusDanger);
      expect(style.borderColor).toBe(THEME.colors.accent);
    }
  });

  it("selects the record behind a pressed bar, by the row seq the ledger uses", () => {
    // The bridge field is the cell's own sourceSeq, which is the fold row's seq
    // -- the same identity the ledger selects on, so a bar press needs no
    // re-derivation of cell indexes.
    const picked: number[] = [];
    render({ platform: "web", onSelectSpan: (sourceSeq) => picked.push(sourceSeq) });
    const first = spans()[0] as HTMLButtonElement;
    act(() => first.click());
    expect(picked).toEqual([FIXTURE_ROWS[0].seq]);
  });

  it("does not make a record with no source seq selectable", () => {
    const { picked, record } = collector();
    // Hand-built cell with no sourceSeq: there is nothing to open, and the strip
    // must not invent a target.
    const turns = [
      {
        turn: 1,
        groups: [
          {
            title: "Message",
            cells: [{ index: 1, kind: "message" as const, text: "orphan", timeSeconds: 0 }],
          },
        ],
      },
    ] satisfies readonly TrajectoryTurnModel[];
    act(() => {
      root.render(
        <TrajectoryTimelineStrip
          turns={turns}
          actualDuration={false}
          compact={false}
          theme={THEME}
          platform="web"
          onSelectSpan={record}
        />,
      );
    });
    const orphan = spans()[0] as HTMLButtonElement;
    expect(orphan.getAttribute("data-disabled")).toBe("1");
    act(() => orphan.click());
    expect(picked).toEqual([]);
  });
});
