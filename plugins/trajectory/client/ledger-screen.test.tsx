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
  /**
   * RN's FlatList is a class component, so `ref.current` is an instance that
   * exposes `scrollToEnd`. Tail-follow is only observable if the stand-in
   * reproduces that: as a plain function component React never attaches the
   * ref, `listRef.current` stayed null, and the `onContentSizeChange` guard on
   * it made every follow path a silent no-op. forwardRef plus
   * useImperativeHandle restores the real contract.
   *
   * It still renders every row through `data.map`, so it says nothing about
   * mounted rows or a real window.
   */
  FlatList: React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    const { data, renderItem, keyExtractor, testID } = props as {
      data: ReadonlyArray<{ key: string }>;
      renderItem: (input: { item: unknown }) => React.ReactNode;
      keyExtractor: (item: { key: string }) => string;
      testID?: string;
    };
    listProbe.renders += 1;
    listProbe.props = props;
    React.useImperativeHandle(ref, () => ({
      scrollToEnd: () => {
        listProbe.scrollToEndCalls += 1;
      },
    }));
    return React.createElement(
      "div",
      { "data-testid": testID },
      data.map((item) =>
        React.createElement(
          "div",
          { key: keyExtractor(item), "data-row": keyExtractor(item) },
          renderItem({ item }),
        ),
      ),
    );
  }),
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

/**
 * What the FlatList stand-in saw on its last render, plus how many times it
 * rendered and how often follow asked it to scroll. `vi.hoisted` because the
 * mock factory below runs before ordinary module-level declarations.
 */
const listProbe = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  renders: 0,
  scrollToEndCalls: 0,
}));

import { LedgerScreen } from "./ledger-screen.js";
import type { TrajectoryFoldRow } from "../shared/dsh/layout.js";
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
  listProbe.props = null;
  listProbe.renders = 0;
  listProbe.scrollToEndCalls = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(overrides: { compact?: boolean } = {}): void {
  renderRows(FIXTURE_ROWS, overrides);
}

/**
 * Re-render with an explicit row set, so a test can prepend history.
 * `turnNumbers` defaults to the fixture map; pass `null` to let numbering be
 * derived from row order, which is the real live-data case (turnNumbersFor
 * returns only explicit entries, so a map that omits a turnId drops it).
 */
function renderRows(
  rows: readonly TrajectoryFoldRow[],
  overrides: { compact?: boolean; turnNumbers?: ReadonlyMap<string, number> | null } = {},
): void {
  const turnNumbers =
    overrides.turnNumbers === null ? undefined : (overrides.turnNumbers ?? FIXTURE_TURN_NUMBERS);
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

const BASE_MS = Date.parse("2026-09-26T00:00:00Z");

/** A minimal row, so a test can build a turn set with distinct identities. */
function foldRow(
  seq: number,
  overrides: Partial<TrajectoryFoldRow> & Pick<TrajectoryFoldRow, "kind">,
): TrajectoryFoldRow {
  return {
    seq,
    timeMs: BASE_MS + seq * 1_000,
    label: "unknown",
    durationMs: null,
    turnId: "t1",
    step: null,
    ...overrides,
  };
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

/** A scroll event the way the list would deliver one. */
function driveScroll(input: { y: number; viewport: number; contentHeight?: number }): void {
  const props = listProbe.props as { onScroll?: (event: unknown) => void } | null;
  if (props?.onScroll === undefined) throw new Error("FlatList never rendered");
  act(() => {
    props.onScroll?.({
      nativeEvent: {
        contentOffset: { y: input.y },
        // Omitted entirely when not supplied: an event that carries no content
        // measurement, which the list is free to deliver.
        ...(input.contentHeight === undefined
          ? {}
          : { contentSize: { height: input.contentHeight } }),
        layoutMeasurement: { height: input.viewport },
      },
    });
  });
}

/** An append: the list's content grows, and follow may answer with a scroll. */
function appendRows(): number {
  const props = listProbe.props as { onContentSizeChange?: (w: number, h: number) => void } | null;
  const before = listProbe.scrollToEndCalls;
  act(() => props?.onContentSizeChange?.(320, 5000));
  return listProbe.scrollToEndCalls - before;
}

const AT_BOTTOM = { y: 4000, contentHeight: 5000, viewport: 1000 };
const SCROLLED_UP = { y: 0, contentHeight: 5000, viewport: 1000 };

describe("ledger screen tail-follow", () => {
  it("engages at the bottom, stops on scroll-up, and re-arms back at the bottom", () => {
    render();
    // Opening a live ledger starts at the tail.
    expect(appendRows()).toBe(1);

    driveScroll(SCROLLED_UP);
    expect(appendRows()).toBe(0);

    driveScroll(AT_BOTTOM);
    expect(appendRows()).toBe(1);
  });

  it("a scroll event carrying no content measurement does not re-arm follow", () => {
    render();
    driveScroll(SCROLLED_UP);
    expect(appendRows()).toBe(0);

    // No contentSize: the event cannot say where the list is. Deciding "at the
    // bottom" from an unmeasurable event re-arms follow, and the next append
    // then yanks a scrolled-up view back to the tail.
    driveScroll({ y: 0, viewport: 1000 });
    expect(appendRows()).toBe(0);
  });

  it("flipping follow mid-scroll does not re-render the list", () => {
    render();
    driveScroll(SCROLLED_UP);

    const before = listProbe.renders;
    driveScroll(AT_BOTTOM);
    expect({ reRenders: listProbe.renders - before }).toEqual({ reRenders: 0 });

    // And a run of ticks that changes nothing re-renders nothing either.
    const beforeTicks = listProbe.renders;
    for (let i = 0; i < 5; i++) driveScroll(AT_BOTTOM);
    expect({ reRenders: listProbe.renders - beforeTicks }).toEqual({ reRenders: 0 });
  });
});

/**
 * Turn identity must be content-derived. A windowed list keys rows by
 * identity, so a positional key ("turn-2") that means a different turn after
 * older history is prepended remounts every chrome row and re-points the fold
 * state at the wrong turn. S4 prepends history, so this is its prerequisite.
 */
describe("ledger screen turn identity", () => {
  const TURN_A: TrajectoryFoldRow[] = [
    foldRow(0, { kind: "user", turnId: "a", label: "turn a prompt" }),
    foldRow(1, { kind: "message", turnId: "a", step: 1, label: "turn a answer" }),
  ];
  const TURN_X: TrajectoryFoldRow[] = [
    foldRow(3, { kind: "user", turnId: "x", label: "older turn x prompt" }),
  ];

  const cellLabels = (): string[] =>
    [...document.querySelectorAll('[data-testid="cell-text"]')].map(
      (node) => node.textContent ?? "",
    );

  it("an open turn stays open when older history is prepended", () => {
    renderRows(TURN_A, { turnNumbers: null });
    act(() =>
      (document.querySelector('[data-testid="turn-header-1"]') as HTMLButtonElement).click(),
    );
    expect(cellLabels()).toContain("turn a prompt");

    // Older history lands above. Turn A is now the second turn, but it is the
    // same turn: its open state and its row identity have to follow it.
    renderRows([...TURN_X, ...TURN_A], { turnNumbers: null });
    expect(cellLabels()).toContain("turn a prompt");
  });

  it("two assistant messages with a null step in one turn do not collide", () => {
    // recorder.ts yields step=null when no step is open, so both of these get
    // the same recordId: `assistant\0<turn>\00`. The virtual-row projection
    // keys on recordId and drops a duplicate key, so one message disappears.
    const twoMessages: TrajectoryFoldRow[] = [
      foldRow(0, { kind: "user", turnId: "t1", label: "prompt" }),
      foldRow(1, { kind: "message", turnId: "t1", step: null, label: "first answer" }),
      foldRow(2, { kind: "message", turnId: "t1", step: null, label: "second answer" }),
    ];
    renderRows(twoMessages, { turnNumbers: null });
    act(() =>
      (document.querySelector('[data-testid="toggle-turns"]') as HTMLButtonElement).click(),
    );

    const labels = cellLabels();
    expect(labels).toContain("first answer");
    expect(labels).toContain("second answer");
  });
});
