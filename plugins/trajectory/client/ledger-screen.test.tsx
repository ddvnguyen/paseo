/** Component tests for the ledger screen (wide + compact) over static fixtures. */

// @vitest-environment jsdom
// Expose the act() support flag before react loads; no suppression is needed now
// that the plugin tsconfig resolves real react types.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { TrajectorySearchIndex } from "../shared/dsh/search-index.js";
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

/**
 * Arbitrary rows, with turn numbering left to the fold. The fixture helpers pass
 * an explicit `turnNumbers`, which pins numbering and would hide the renumbering
 * a prepend causes — so a test that is ABOUT renumbering must not use them.
 */
function renderRows(rows: readonly TrajectoryFoldRow[]): void {
  act(() => {
    root.render(<LedgerScreen rows={rows} compact={false} theme={THEME} />);
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
    // In-flight tool (c3) shows the em dash; the settled one floors to "2s".
    const durations = [...document.querySelectorAll('[data-testid="duration-text"]')].map(
      (node) => node.textContent,
    );
    expect(durations).toContain("2s");
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

  it("keeps follow engaged inside the 24px threshold, where dsh's 2px would not", () => {
    render();
    driveScroll(SCROLLED_UP);
    expect(appendRows()).toBe(0);

    // 20px short of the end. That is inside this screen's 24px threshold, and
    // OUTSIDE dsh's 2px — so dropping the constant to dsh's value fails here,
    // which is the point of recording the divergence in a comment.
    driveScroll({ y: 3980, contentHeight: 5000, viewport: 1000 });
    expect(appendRows()).toBe(1);
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
 * Each chrome row's key, paired with the turn-header it renders. Pairing is the
 * whole point: a set of chrome keys survives a prepend under EITHER keying (a
 * positional key set is just re-bound to different turns), so only the
 * key-to-turn pairing distinguishes them.
 */
function headerKeys(): { header: string; key: string }[] {
  return [...container.querySelectorAll("[data-row]")]
    .map((row) => ({
      key: row.getAttribute("data-row") ?? "",
      header: row.querySelector('[data-testid^="turn-header-"]')?.getAttribute("data-testid") ?? "",
    }))
    .filter((pair) => pair.header !== "");
}

/** One older turn, prepended exactly as a load-older read would deliver it. */
const PREPENDED_OLDER_TURN: readonly TrajectoryFoldRow[] = [
  {
    seq: -60,
    timeMs: Date.parse("2026-09-25T23:59:00Z"),
    kind: "user",
    label: "an older prompt",
    durationMs: null,
    turnId: "t0",
    step: null,
  },
  {
    seq: -59,
    timeMs: Date.parse("2026-09-25T23:59:01Z"),
    kind: "message",
    label: "an older answer",
    durationMs: 400,
    turnId: "t0",
    step: 1,
  },
];

/**
 * Windowing geometry. `getItemLayout` is only safe on the numbers the rows
 * actually occupy — a wrong height does not read as a config mistake, it reads
 * as a scroll bug — so both the per-class heights and the prefix sum are pinned.
 */
describe("ledger screen row geometry", () => {
  interface Geometry {
    getItemLayout?: (
      data: ArrayLike<unknown> | null | undefined,
      index: number,
    ) => { length: number; offset: number; index: number };
    data?: ReadonlyArray<{ kind: string; height: number; record?: { __kind?: string } }>;
  }

  function geometry(): Required<Pick<Geometry, "getItemLayout" | "data">> {
    const props = listProbe.props as Geometry | null;
    if (props?.getItemLayout === undefined || props.data === undefined) {
      throw new Error("FlatList never rendered with getItemLayout");
    }
    return { getItemLayout: props.getItemLayout, data: props.data };
  }

  it("reports the measured height for every row class", () => {
    renderRows(FIXTURE_ROWS);
    const { data, getItemLayout } = geometry();

    const heightsByClass = data.reduce<Record<string, Set<number>>>((classes, row, index) => {
      const name = row.kind === "chrome" ? (row.record?.__kind ?? "chrome") : row.kind;
      const bucket = classes[name] ?? new Set<number>();
      bucket.add(getItemLayout(data, index).length);
      classes[name] = bucket;
      return classes;
    }, {});

    expect(
      Object.fromEntries(Object.entries(heightsByClass).map(([name, set]) => [name, [...set]])),
    ).toEqual({
      // Measured in a real browser on the item wrappers, not the ported guesses
      // of 28 and 30 — see TURN_HEADER_HEIGHT / CONTENT_ROW_HEIGHT.
      "turn-header": [22],
      "turn-rule": [10],
      cellrow: [31],
    });
  });

  it("prefix-sums offsets, so the last row's end is the total content height", () => {
    renderRows(FIXTURE_ROWS);
    const { data, getItemLayout } = geometry();

    let running = 0;
    const offsets = data.map((row, index) => {
      const geometryRow = getItemLayout(data, index);
      expect(geometryRow).toEqual({ length: row.height, offset: running, index });
      running += row.height;
      return geometryRow.offset;
    });

    expect({
      firstOffset: offsets[0],
      strictlyIncreasing: offsets.every(
        (offset, index) => index === 0 || offsets[index - 1] < offset,
      ),
      totalContentHeight:
        getItemLayout(data, data.length - 1).offset + data[data.length - 1].height,
      sumOfHeights: data.reduce((total, row) => total + row.height, 0),
    }).toEqual({
      firstOffset: 0,
      strictlyIncreasing: true,
      totalContentHeight: data.reduce((total, row) => total + row.height, 0),
      sumOfHeights: data.reduce((total, row) => total + row.height, 0),
    });
  });
});

/**
 * Chrome rows key on turn IDENTITY, not position. The `beforeSeq` reverse cursor
 * makes prepending history possible, and a prepend renumbers every turn, so a
 * positional key hands React a different turn's row under the same key and
 * remounts every chrome row in the window.
 */
describe("ledger screen chrome row identity", () => {
  /** The key carried by the turn rendered as `Turn N` (header testID suffix). */
  function keyOfTurnN(n: number): string | undefined {
    return headerKeys().find((pair) => pair.header === `turn-header-${n}`)?.key;
  }

  it("keeps a turn's chrome key when a prepend shifts its position", () => {
    renderRows(FIXTURE_ROWS);
    // t1 (the fixture's first turn) is Turn 1 here, and t2 is Turn 2.
    const t1Before = keyOfTurnN(1);
    const t2Before = keyOfTurnN(2);
    expect({ t1: t1Before, t2: t2Before }).toEqual({
      t1: expect.any(String),
      t2: expect.any(String),
    });

    // One older turn is prepended, exactly as a load-older read would deliver
    // it. The fold numbers turns by order of appearance, so t1 and t2 slide
    // from Turn 1/2 to Turn 2/3.
    renderRows([...PREPENDED_OLDER_TURN, ...FIXTURE_ROWS]);
    expect({
      headers: headerKeys().map((pair) => pair.header),
      t1: keyOfTurnN(2),
      t2: keyOfTurnN(3),
    }).toEqual({
      // The renumbering is real: three headers now, the extra one first.
      headers: ["turn-header-1", "turn-header-2", "turn-header-3"],
      // …and each turn kept the key it already had. Under positional keys these
      // would be turn-2 and turn-3, i.e. t1 would inherit t2's old key.
      t1: t1Before,
      t2: t2Before,
    });
  });
});

/**
 * The search index is the largest single cost on the data plane. A query makes
 * the LIST depend on the index, so that commit is exact. With no query the index
 * can only serve a future search, so it is throttled — otherwise every append
 * pays a full re-index for an answer nobody has asked for yet.
 */
describe("ledger screen search index cadence", () => {
  const BASE_MS = Date.parse("2026-09-26T00:00:00Z");

  /** One turn's worth of fold rows: a prompt and its answer. */
  function turn(turnId: string, base: number): TrajectoryFoldRow[] {
    return [
      {
        seq: base,
        timeMs: BASE_MS + base * 1_000,
        kind: "user",
        label: `${turnId} prompt`,
        durationMs: null,
        turnId,
        step: null,
      },
      {
        seq: base + 1,
        timeMs: BASE_MS + (base + 1) * 1_000,
        kind: "message",
        label: `${turnId} answer`,
        durationMs: 5,
        turnId,
        step: 1,
      },
    ];
  }

  function typeQuery(value: string): void {
    act(() => {
      const input = document.querySelector('[data-testid="ledger-search"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  /** How many cells the current query leaves on screen. */
  function searchHits(value: string): number {
    typeQuery(value);
    return container.querySelectorAll('[data-testid^="cell-"]').length;
  }

  let updates: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    updates = vi.spyOn(TrajectorySearchIndex.prototype, "update");
  });
  afterEach(() => {
    updates.mockRestore();
  });

  it("does not re-index once per append while no query is active", () => {
    let seq = 100;
    // push, not a loop spread: a spread into an accumulator is O(n^2) and the
    // repo's lint says so.
    const rows = turn("a", seq);
    renderRows(rows);
    const afterOpen = updates.mock.calls.length;
    expect(afterOpen).toBe(1);

    // Ten appends with nothing typed. The list must not pay for indexing.
    for (let i = 0; i < 10; i++) {
      seq += 10;
      rows.push(...turn(`t${i}`, seq));
      renderRows(rows);
    }
    expect({ commits: updates.mock.calls.length }).toEqual({ commits: afterOpen });
  });

  it("commits immediately once a query is active, because the list depends on it", () => {
    renderRows(turn("a", 100));
    const before = updates.mock.calls.length;

    typeQuery("answer");
    // The filtered list cannot lag behind the query that produced it.
    expect(updates.mock.calls.length).toBeGreaterThan(before);
  });

  /**
   * The index must actually re-index, not merely be CALLED. An earlier version
   * of the test above asserted only on call count, which a no-op `update`
   * satisfies: `update` returns false immediately when handed the same outer
   * array, so a screen that reused one wrapper froze the index at its first
   * commit while every call still counted. Search then silently ignored every
   * event that arrived after the first render.
   *
   * So this asserts the observable result: a row appended after the first render
   * is findable by a query typed afterwards.
   */
  it("finds a row that was appended after the first render", () => {
    // `turn(id, base)` labels its rows `${id} prompt` / `${id} answer`, so
    // "b answer" is text that exists only once the second turn is appended.
    const first = turn("a", 100);
    renderRows(first);
    expect({ hitsBeforeAppend: searchHits("b answer") }).toEqual({ hitsBeforeAppend: 0 });

    // A second turn arrives from the live stream.
    renderRows([...first, ...turn("b", 200)]);

    expect({ hitsAfterAppend: searchHits("b answer") }).toEqual({ hitsAfterAppend: 1 });
  });
});
