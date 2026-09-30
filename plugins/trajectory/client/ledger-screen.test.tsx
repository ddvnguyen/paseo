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
  View: ({ children, testID }: React.PropsWithChildren<{ testID?: string }>) =>
    React.createElement("div", { "data-testid": testID }, children),
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
  }: React.PropsWithChildren<{ onPress?: () => void; testID?: string }>) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID, onClick: onPress },
      children,
    ),
}));

import type { TrajectoryFoldRow } from "../shared/dsh/layout.js";
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

function render(overrides: { compact?: boolean; extraTurn?: boolean } = {}): void {
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

  it("the Turns toggle hides tool rows with characters and durations, then restores them", () => {
    render();
    const visible = () =>
      container.querySelectorAll('[data-testid="ledger-list"] [data-testid^="cell-"]').length;
    const shown = visible();
    expect(shown).toBeGreaterThan(0);
    // Already open by default, so the toggle collapses everything.
    act(() =>
      (document.querySelector('[data-testid="toggle-turns"]') as HTMLButtonElement).click(),
    );
    expect(visible()).toBe(0);
    act(() =>
      (document.querySelector('[data-testid="toggle-turns"]') as HTMLButtonElement).click(),
    );
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

  function press(testID: string): void {
    act(() => (container.querySelector(`[data-testid="${testID}"]`) as HTMLButtonElement).click());
  }

  function cells(): Element[] {
    return [...container.querySelectorAll('[data-testid^="cell-"]')];
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

  it("renders the toolbar: Duration, Turns and a search box, and no Calls toggle", () => {
    render();
    for (const id of ["toggle-duration", "toggle-turns", "ledger-search"]) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="toggle-calls"]')).toBeNull();
  });

  it("the Turns toggle closes every turn and opens them again", () => {
    render();
    const open = cells().length;
    expect(open).toBeGreaterThan(0);

    press("toggle-turns");
    expect(cells()).toHaveLength(0);

    press("toggle-turns");
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
    press("toggle-turns");
    expect(cells()).toHaveLength(0);

    // A match must still be reachable without the reader reopening anything.
    search("npm");
    expect(cells().length).toBeGreaterThan(0);
  });

  it("search matches the user prompt label of a later turn", () => {
    render();
    press("toggle-turns");
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
    press("toggle-turns");
    search("zzzz-no-such-term");
    expect(cells()).toHaveLength(0);
  });
});
