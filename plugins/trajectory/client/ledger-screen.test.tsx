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

function render(overrides: { compact?: boolean } = {}): void {
  act(() => {
    root.render(
      <LedgerScreen
        rows={FIXTURE_ROWS}
        turnNumbers={FIXTURE_TURN_NUMBERS}
        openCallIds={FIXTURE_OPEN_CALLS}
        compact={overrides.compact === true}
        theme={THEME}
      />,
    );
  });
}

describe("ledger screen", () => {
  it("renders one folded header per turn plus the heavier inter-turn rule", () => {
    render();
    expect(document.querySelector('[data-testid="turn-header-1"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="turn-header-2"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="turn-rule"]')).toHaveLength(1);
    // Folded by default: no cell rows visible.
    expect(document.querySelector('[data-testid="ledger-list"] [data-testid^="cell-"]')).toBeNull();
  });

  it("unfolds a turn on press and shows Message group + folded Step headers", () => {
    render();
    const header = document.querySelector('[data-testid="turn-header-1"]') as HTMLButtonElement;
    act(() => header.click());
    // User cell from the Message group is visible; Step 1 stays folded.
    expect(document.querySelectorAll('[data-testid^="cell-"]').length).toBeGreaterThan(0);
    const stepHeader = document.querySelector(
      '[data-testid="step-header-Step 1"]',
    ) as HTMLButtonElement;
    expect(stepHeader).not.toBeNull();
    // No tool cells while the step is folded.
    expect(document.querySelector('[data-testid="chars-text"]')).toBeNull();
  });

  it("the Turns toggle exposes tool rows with characters and durations, then collapses", () => {
    render();
    act(() =>
      (document.querySelector('[data-testid="toggle-turns"]') as HTMLButtonElement).click(),
    );
    // In-flight tool (c3) shows the em dash; settled one shows 2,400 ms.
    const durations = [...document.querySelectorAll('[data-testid="duration-text"]')].map(
      (node) => node.textContent,
    );
    expect(durations).toContain("2,400 ms");
    expect(durations).toContain("—");
    const chars = [...document.querySelectorAll('[data-testid="chars-text"]')].map(
      (node) => node.textContent,
    );
    expect(chars).toContain("characters: 1,520");
    // Everything is open now, so the same toggle closes it again.
    act(() =>
      (document.querySelector('[data-testid="toggle-turns"]') as HTMLButtonElement).click(),
    );
    expect(document.querySelector('[data-testid="ledger-list"] [data-testid^="cell-"]')).toBeNull();
  });

  it("wide layout renders wordy kind tags; compact renders icons and skips turn usage", () => {
    // Turns fold by default (first test), so unfold before asserting cell tags.
    render({ compact: false });
    act(() =>
      (document.querySelector('[data-testid="toggle-turns"]') as HTMLButtonElement).click(),
    );
    expect(document.querySelector('[data-testid="kind-tag-user"]')?.textContent).toBe("user");
    const wideRules = document.querySelectorAll('[data-testid="turn-rule"]').length;
    // Re-render the same root with compact=true: fold state persists, so the
    // rule count is directly comparable and no unmount/remount is needed.
    render({ compact: true });
    expect(document.querySelector('[data-testid="kind-tag-user"]')?.textContent).toBe("U");
    expect(document.querySelectorAll('[data-testid="turn-rule"]').length).toBe(wideRules);
  });
  // --- dsh toolbar parity (C4) -------------------------------------------

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

  it("renders the dsh toolbar: Duration, Turns, Calls and a search box", () => {
    render();
    for (const id of ["toggle-duration", "toggle-turns", "toggle-calls", "ledger-search"]) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });

  it("the Turns toggle opens every turn and closes them again", () => {
    render();
    expect(cells()).toHaveLength(0);

    press("toggle-turns");
    const open = cells().length;
    expect(open).toBeGreaterThan(0);

    press("toggle-turns");
    expect(cells()).toHaveLength(0);
  });

  it("the Calls toggle folds tool groups while leaving Message rows visible", () => {
    function toolRows(): Element[] {
      return [...container.querySelectorAll('[data-testid="chars-text"]')];
    }
    render();
    press("toggle-turns");
    expect(toolRows().length).toBeGreaterThan(0);

    press("toggle-calls");
    // Tool rows live in Step groups, so they fold; Message-group rows do not.
    expect(toolRows()).toHaveLength(0);
    expect(cells().length).toBeGreaterThan(0);

    press("toggle-calls");
    expect(toolRows().length).toBeGreaterThan(0);
  });

  it("search filters rows to the matching record", () => {
    render();
    press("toggle-turns");
    const all = cells().length;

    // "npm" appears only in the shell tool label.
    search("npm");
    const matched = cells();
    expect(matched.length).toBeGreaterThan(0);
    expect(matched.length).toBeLessThan(all);
    expect(matched.some((node) => node.textContent?.includes("npm"))).toBe(true);
  });

  it("search reveals a match that sits inside a folded turn", () => {
    render();
    expect(cells()).toHaveLength(0);

    // Turns start folded; a match must still be reachable without pressing Turns.
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
    press("toggle-turns");
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
