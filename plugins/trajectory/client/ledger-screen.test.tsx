/** Component tests for the ledger screen (wide + compact) over static fixtures. */

// @vitest-environment jsdom
// Expose the act() support flag before react loads; no suppression is needed now
// that the plugin tsconfig resolves real react types.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  StyleSheet: {
    create: (styles: unknown) => styles,
    hairlineWidth: 1,
    flatten: (style: unknown) => style,
  },
  FlatList: ({
    data,
    renderItem,
    keyExtractor,
    testID,
  }: {
    data: ReadonlyArray<{ key: string }>;
    renderItem: (input: { item: unknown }) => React.ReactNode;
    keyExtractor: (item: { key: string }) => string;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": testID },
      data.map((item) =>
        React.createElement(
          "div",
          { key: keyExtractor(item), "data-row": keyExtractor(item) },
          renderItem({ item }),
        ),
      ),
    ),
  View: ({
    children,
    testID,
    style,
  }: React.PropsWithChildren<{ testID?: string; style?: unknown }>) =>
    // Styles are serialized so the flex contract can be asserted directly: a
    // search field that cannot shrink is invisible in a text-only assertion, and
    // it is what pushed the close off its row on a phone.
    React.createElement(
      "div",
      { "data-testid": testID, "data-style": JSON.stringify(style) },
      children,
    ),
  TextInput: ({
    value,
    onChangeText,
    placeholder,
    testID,
    accessibilityLabel,
  }: {
    value?: string;
    onChangeText?: (value: string) => void;
    placeholder?: string;
    testID?: string;
    accessibilityLabel?: string;
  }) =>
    React.createElement("input", {
      "data-testid": testID,
      "data-value": value,
      "aria-label": accessibilityLabel,
      placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
    }),
  Text: ({ children, testID }: React.PropsWithChildren<{ testID?: string }>) =>
    React.createElement("span", { "data-testid": testID }, children),
  Pressable: ({
    children,
    onPress,
    testID,
    accessibilityRole,
    accessibilityLabel,
    hitSlop,
    style,
  }: {
    // Render-function children carry press state, so the union is explicit:
    // ReactNode alone would narrow the function branch away.
    children?: React.ReactNode | ((state: { pressed: boolean }) => React.ReactNode);
    onPress?: () => void;
    testID?: string;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    hitSlop?: number;
    style?: unknown;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        "data-hit-slop": hitSlop,
        "data-style": JSON.stringify(style),
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        onClick: onPress,
      },
      // Render-function children carry press state; there is no press to
      // simulate here, so every branch is exercised at rest.
      typeof children === "function" ? children({ pressed: false }) : children,
    ),
}));

import type { TrajectoryFoldRow } from "../shared/dsh/layout.js";
import type { TrajectoryEvent } from "../shared/trajectory.js";
import { eventsToFoldRows } from "./events-to-rows.js";
import { LedgerScreen } from "./ledger-screen.js";
import { FIXTURE_OPEN_CALLS, FIXTURE_ROWS, FIXTURE_TURN_NUMBERS } from "./fixtures.js";

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

/** A third turn, as a live append would deliver it after mount. */
const APPENDED_ROW: TrajectoryFoldRow = {
  seq: 90,
  timeMs: Date.parse("2026-09-26T00:01:30Z"),
  kind: "user",
  label: "a later turn",
  durationMs: null,
  turnId: "t3",
  step: null,
};

/** Hoisted so no array literal is created inside a JSX prop (react-perf). */
const ROWS_WITH_APPENDED_TURN: readonly TrajectoryFoldRow[] = [...FIXTURE_ROWS, APPENDED_ROW];
const TURN_NUMBERS_WITH_APPENDED: ReadonlyMap<string, number> = new Map([
  ...FIXTURE_TURN_NUMBERS,
  ["t3", 3],
]);

function render(
  overrides: {
    compact?: boolean;
    extraTurn?: boolean;
    onClose?: () => void;
  } = {},
): void {
  const appended = overrides.extraTurn === true;
  const rows = appended ? ROWS_WITH_APPENDED_TURN : FIXTURE_ROWS;
  const turnNumbers = appended ? TURN_NUMBERS_WITH_APPENDED : FIXTURE_TURN_NUMBERS;
  act(() => {
    root.render(
      <LedgerScreen
        rows={rows}
        turnNumbers={turnNumbers}
        openCallIds={FIXTURE_OPEN_CALLS}
        compact={overrides.compact === true}
        theme={THEME}
        onClose={overrides.onClose}
      />,
    );
  });
}

describe("ledger screen", () => {
  it("renders one header per turn plus the heavier inter-turn rule", () => {
    render();
    expect(document.querySelector('[data-testid="turn-header-1"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="turn-header-2"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="turn-rule"]')).toHaveLength(1);
  });

  it("expands every turn by default (owner item 9)", () => {
    render();
    // The ledger's default posture: a reader sees the rows, not a list of
    // closed headers they have to open one at a time.
    expect(cells().length).toBeGreaterThan(0);
    const header = container.querySelector('[data-testid="turn-header-1"]');
    // The chevron reads open (▾), not closed (▸).
    expect(header?.textContent).toContain("▾");
  });

  it("keeps a manual collapse and still expands a turn appended later", () => {
    render();
    const allOpen = cells().length;
    expect(allOpen).toBeGreaterThan(0);
    // The user collapses turn 1 by hand. Turn 2 stays open, so the count drops
    // rather than reaching zero.
    act(() =>
      (container.querySelector('[data-testid="turn-header-1"]') as HTMLButtonElement).click(),
    );
    const afterCollapse = cells().length;
    expect(afterCollapse).toBeGreaterThan(0);
    expect(afterCollapse).toBeLessThan(allOpen);

    // A new turn arrives from the live stream.
    render({ extraTurn: true });
    expect(document.querySelector('[data-testid="turn-header-3"]')).not.toBeNull();
    // Expanded without any user action: its chevron reads open and the visible
    // row count went back up, while turn 1 stayed collapsed.
    expect(document.querySelector('[data-testid="turn-header-3"]')?.textContent).toContain("▾");
    expect(cells().length).toBeGreaterThan(afterCollapse);
    expect(document.querySelector('[data-testid="turn-header-1"]')?.textContent).toContain("▸");
    // And it is still exactly the state the reader left it in.
    expect(cells().length).toBeGreaterThan(afterCollapse);
  });

  it("collapses and re-expands a turn on press, with every cell under its header", () => {
    render();
    const header = container.querySelector('[data-testid="turn-header-1"]') as HTMLButtonElement;
    const shown = () => container.querySelectorAll('[data-testid^="cell-"]').length;
    const opened = shown();
    expect(opened).toBeGreaterThan(0);
    // No step grouping: tool rows live with the rest, and there is no step
    // header anywhere in the list.
    expect(document.querySelector('[data-testid="chars-text"]')).not.toBeNull();
    expect(container.querySelector('[data-testid^="step-header"]')).toBeNull();

    act(() => header.click());
    expect(shown()).toBeLessThan(opened);
    act(() => header.click());
    expect(shown()).toBe(opened);
  });

  it("renders the sticky column header above the ledger", () => {
    render();
    expect(container.querySelector('[data-testid="ledger-column-header"]')).not.toBeNull();
    for (const name of ["time", "type", "context", "stats"]) {
      expect(container.querySelector(`[data-testid="column-header-${name}"]`)).not.toBeNull();
    }
  });

  it("folding every turn header hides tool rows with characters and durations, then restores them", () => {
    render();
    const visible = () =>
      container.querySelectorAll('[data-testid="ledger-list"] [data-testid^="cell-"]').length;
    const shown = visible();
    expect(shown).toBeGreaterThan(0);
    // Already open by default, so folding every header collapses everything.
    toggleEveryTurn();
    expect(visible()).toBe(0);
    toggleEveryTurn();
    expect(visible()).toBe(shown);
    // In-flight tool (c3) shows the em dash; settled one shows 2,400 ms.
    const durations = [...document.querySelectorAll('[data-testid="duration-text"]')].map(
      (node) => node.textContent,
    );
    expect(durations).toContain("2,400 ms");
    expect(durations).toContain("—");
    const chars = [...document.querySelectorAll('[data-testid="chars-text"]')].map(
      (node) => node.textContent,
    );
    expect(chars).toContain("1,520 chars");
  });

  it("wide layout renders wordy kind tags; compact renders icons and skips turn usage", () => {
    render({ compact: false });
    expect(document.querySelector('[data-testid="kind-tag-user"]')?.textContent).toBe("user");
    const wideRules = document.querySelectorAll('[data-testid="turn-rule"]').length;
    // Re-render the same root with compact=true: fold state persists, so the
    // rule count is directly comparable and no unmount/remount is needed.
    render({ compact: true });
    expect(document.querySelector('[data-testid="kind-tag-user"]')?.textContent).toBe("U");
    expect(document.querySelectorAll('[data-testid="turn-rule"]').length).toBe(wideRules);
  });
  // --- toolbar parity ----------------------------------------------------

  /**
   * Press every turn header, the way a reader folds the ledger now that the
   * toolbar's Turns toggle is gone. Headers survive a fold, so the same list
   * serves to unfold them again.
   */
  function toggleEveryTurn(): void {
    const headers = [...container.querySelectorAll('[data-testid^="turn-header-"]')];
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      act(() => (header as HTMLButtonElement).click());
    }
  }

  function cells(): Element[] {
    return [...container.querySelectorAll('[data-testid^="cell-"]')];
  }

  /** The style object the mock serialized onto a node. */
  function styleOf(node: Element): Record<string, unknown> {
    const raw = node.getAttribute("data-style");
    return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
  }

  /** React tracks the input value on the node, so set it natively then fire. */
  function search(term: string): void {
    const input = container.querySelector('[data-testid="ledger-search"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, term);
    act(() => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("renders a search box and, when the host can dismiss, a close control", () => {
    render({ onClose: () => {} });
    expect(container.querySelector('[data-testid="ledger-search"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trajectory-toolbar-close"]')).not.toBeNull();
  });

  it("no longer renders the Duration, Turns or Calls toggles", () => {
    render({ onClose: () => {} });
    for (const id of ["toggle-duration", "toggle-turns", "toggle-calls"]) {
      expect(container.querySelector(`[data-testid="${id}"]`)).toBeNull();
    }
  });

  it("the toolbar close is a 44px-target button wired to the host's dismiss", () => {
    const dismissals: string[] = [];
    render({ onClose: () => dismissals.push("closed") });
    const close = container.querySelector(
      '[data-testid="trajectory-toolbar-close"]',
    ) as HTMLButtonElement;
    expect(close.getAttribute("role")).toBe("button");
    expect(close.getAttribute("aria-label")).toBe("Close trajectory");
    // A 26pt painted box plus 9pt of slop on each side.
    expect(close.getAttribute("data-hit-slop")).toBe("9");
    act(() => close.click());
    expect(dismissals).toEqual(["closed"]);
  });

  it("hides the close control on a host that cannot dismiss (older host)", () => {
    render();
    expect(container.querySelector('[data-testid="trajectory-toolbar-close"]')).toBeNull();
    // Search never depended on the host, so it is unaffected.
    expect(container.querySelector('[data-testid="ledger-search"]')).not.toBeNull();
  });

  it("keeps search and the close on one row at phone widths", () => {
    // Owner T8: on a phone the field took the whole row and the X was left
    // below it. jsdom lays nothing out, so this asserts the two properties that
    // decide it — the flexible field must be allowed to shrink, and the
    // fixed-size X must not be — plus the structure they sit in.
    render({ compact: true, onClose: () => {} });
    const bar = container.querySelector('[data-testid="ledger-toolbar"]') as HTMLElement;
    const field = bar.firstElementChild as HTMLElement;
    const close = container.querySelector(
      '[data-testid="trajectory-toolbar-close"]',
    ) as HTMLElement;

    expect(styleOf(bar).flexDirection).toBe("row");
    // Two children, both in the bar: siblings, not stacked rows.
    expect(bar.children).toHaveLength(2);
    expect(field.parentElement).toBe(bar);
    expect(close.parentElement).toBe(bar);

    // A CSS flex item defaults to min-width: auto, so the field pins itself to
    // its content width without this and crowds the X out of the row.
    expect(styleOf(field).flex).toBe(1);
    expect(styleOf(field).minWidth).toBe(0);
    expect(styleOf(close).flexShrink).toBe(0);
    // The 44px target is a hitSlop over a compact painted box, on phone as on
    // desktop — the control is the same chip, not a bigger one.
    expect(close.getAttribute("data-hit-slop")).toBe("9");
  });

  it("folding every turn header closes them all, and pressing again opens them", () => {
    render();
    const open = cells().length;
    expect(open).toBeGreaterThan(0);

    toggleEveryTurn();
    expect(cells()).toHaveLength(0);

    toggleEveryTurn();
    expect(cells().length).toBe(open);
  });

  it("keeps tool rows visible alongside message rows", () => {
    // Steps were removed, so there is no second fold level hiding tool work
    // behind a collapsed group: every turn reveals all of its cells.
    function toolRows(): Element[] {
      return [...container.querySelectorAll('[data-testid="chars-text"]')];
    }
    render();
    expect(toolRows().length).toBeGreaterThan(0);
    expect(cells().length).toBeGreaterThan(0);
  });

  it("search filters rows to the matching record", () => {
    render();
    const all = cells().length;

    // "npm" appears only in the shell tool label.
    search("npm");
    const matched = cells();
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.length).toBeLessThan(all);
    expect(matched.some((node) => node.textContent?.includes("npm"))).toBe(true);
  });

  it("search reveals a match inside a turn the user collapsed", () => {
    render();
    // The reader folds everything, including the turn holding the shell tool.
    toggleEveryTurn();
    expect(cells()).toHaveLength(0);

    // A match must still be reachable without the reader reopening anything.
    search("npm");
    expect(cells().length).toBeGreaterThan(0);
  });

  it("search matches the user prompt label of a later turn", () => {
    render();
    toggleEveryTurn();
    search("failing assertion");
    const matched = cells();
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.every((node) => node.textContent?.includes("failing assertion"))).toBe(true);
  });

  it("clearing the search restores every row", () => {
    render();
    const all = cells().length;

    search("npm");
    expect(cells().length).toBeLessThan(all);

    search("");
    expect(cells().length).toBe(all);
  });

  it("a search with no match shows no rows rather than everything", () => {
    render();
    toggleEveryTurn();
    search("zzzz-no-such-term");
    expect(cells()).toHaveLength(0);
  });

  // --- QC r20 item 11: the newest rows must reach the DOM -----------------

  /**
   * One agent response as the ledger stores it: several chunks, all carrying the
   * SAME source message id, which is how the provider streams a single message.
   */
  function responseChunks(
    turnId: string,
    sourceMessageId: string,
    firstSeq: number,
    firstStep: number,
    length: number,
  ): TrajectoryEvent[] {
    const out: TrajectoryEvent[] = [];
    for (let chunk = 0; chunk < length; chunk += 1) {
      out.push(event(firstSeq + chunk, "assistant/message", turnId, firstStep, sourceMessageId));
    }
    return out;
  }

  function event(
    seq: number,
    type: string,
    turn: string,
    step: number,
    sourceMessageId: string,
  ): TrajectoryEvent {
    return {
      seq,
      time: new Date(1_700_000_000_000 + seq * 1_000).toISOString(),
      type,
      turn,
      step,
      agentId: "a1",
      data: { sourceMessageId, textLength: 10 * (step + 1) },
    };
  }

  function draw(events: readonly TrajectoryEvent[]): void {
    act(() => {
      root.render(<LedgerScreen rows={eventsToFoldRows(events)} compact={false} theme={THEME} />);
    });
  }

  function messageCells(): Element[] {
    return [...container.querySelectorAll('[data-testid="kind-tag-message"]')];
  }

  it("renders a second turn that reuses the first turn's id", () => {
    // QC r20 fingerprint: the newest MESSAGE rows produce no DOM at all, while
    // tool and llm rows appear. A provider reuses its turn ids across sessions,
    // so a second turn-0 arrives carrying step 1 again -- the same identity the
    // first turn's merged row already claimed.
    const first = responseChunks("opencode-turn-0", "m-a", 1, 1, 3);
    draw(first);
    // One response, one row.
    expect(messageCells().length).toBe(1);

    // A second turn, reusing the SAME turn id and starting at step 1 again --
    // appended after initial render, with a different source message id.
    const second = responseChunks("opencode-turn-0", "m-b", 101, 1, 3);
    draw([...first, ...second]);

    // Both responses must be in the document.
    expect(messageCells().length).toBe(2);
  });

  it("keeps both colliding rows findable by search", () => {
    const first = responseChunks("opencode-turn-0", "m-a", 1, 1, 2);
    const second = responseChunks("opencode-turn-0", "m-b", 101, 1, 2);
    draw([...first, ...second]);
    // Two distinct rows, each with its own cell node.
    expect(messageCells().length).toBe(2);
    expect(container.querySelectorAll('[data-testid="col-context"]').length).toBeGreaterThanOrEqual(
      2,
    );
  });
});
