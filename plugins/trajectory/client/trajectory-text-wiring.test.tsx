/**
 * Wiring for on-demand row text, one link per test: the ledger passes a resolved
 * string into a cell, the resolver fills its cache and re-renders a consumer, an
 * unkeyed cell resolves to undefined, and a warm cache does not refetch.
 */

// @vitest-environment jsdom
// Expose the act() support flag before react loads; no suppression is needed now
// that the plugin tsconfig resolves real react types.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrajectoryFoldRow } from "../shared/dsh/layout.js";
import type { TrajectoryCellProps } from "../shared/dsh/record.js";
import { LedgerScreen } from "./ledger-screen.js";
import { useTrajectoryText, type TimelineRefetch } from "./trajectory-text.js";

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
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
  Text: ({ children, testID }: React.PropsWithChildren<{ testID?: string }>) =>
    React.createElement("span", { "data-testid": testID }, children),
  TextInput: () => React.createElement("input", null),
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
} as unknown as Parameters<typeof LedgerScreen>[0]["theme"];

const BASE = Date.parse("2026-09-26T00:00:00Z");
const TURN_NUMBERS = new Map([["t1", 1]]);

function row(overrides: Partial<TrajectoryFoldRow> & Pick<TrajectoryFoldRow, "kind">) {
  return {
    seq: 1,
    timeMs: BASE + 1_000,
    label: "assistant message (84 chars)",
    durationMs: null,
    turnId: "t1",
    step: null,
    ...overrides,
  } as TrajectoryFoldRow;
}

const ALL_TEXT = () => "run the test suite";
const KEYED_ONLY = (cell: TrajectoryCellProps) =>
  cell.sourceMessageId === "m-1" ? "only the keyed one" : undefined;
const NO_TEXT = () => undefined;

const KEYED_ROW = row({ kind: "user", label: "user message (18 chars)", sourceMessageId: "m-1" });
const UNKEYED_ROW = row({ kind: "message", seq: 2, timeMs: BASE + 2_000 });

/** A resolvable cell, as the ledger would hand one to the resolver. */
const KEYED_CELL = {
  index: 1,
  kind: "user",
  text: "user message (18 chars)",
  timeSeconds: 0,
  sourceMessageId: "m-1",
} as TrajectoryCellProps;
const UNKEYED_CELL = {
  index: 1,
  kind: "message",
  text: "assistant message (84 chars)",
  timeSeconds: 0,
} as TrajectoryCellProps;
const ONE_CELL = [KEYED_CELL];
const ONE_UNKEYED_CELL = [UNKEYED_CELL];
const BOTH_ROWS = [KEYED_ROW, UNKEYED_ROW];
const KEYED_ONLY_ROW = [KEYED_ROW];

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

/**
 * Turns render expanded by default (T3 item 9), so there is nothing to expand.
 * Deliberately a no-op: these tests should FAIL if that default ever changes,
 * rather than quietly clicking the toolbar to compensate.
 */
async function expand(): Promise<void> {}

function cellText(index: number): string | null {
  return (
    container.querySelector(`[data-testid="cell-${index}"] [data-testid="col-context"]`)
      ?.textContent ?? null
  );
}

describe("ledger passes resolved text into a cell", () => {
  it("shows the resolved string in place of the length label", async () => {
    await act(async () => {
      root.render(
        <LedgerScreen
          rows={BOTH_ROWS}
          turnNumbers={TURN_NUMBERS}
          compact={false}
          theme={THEME}
          textFor={ALL_TEXT}
        />,
      );
    });
    await expand();

    expect(cellText(1)).toBe("run the test suite");
  });

  it("keeps each cell's own text rather than one string for all", async () => {
    await act(async () => {
      root.render(
        <LedgerScreen
          rows={BOTH_ROWS}
          turnNumbers={TURN_NUMBERS}
          compact={false}
          theme={THEME}
          textFor={KEYED_ONLY}
        />,
      );
    });
    await expand();

    expect(cellText(1)).toBe("only the keyed one");
    expect(cellText(2)).toBe("assistant message (84 chars)");
  });

  it("keeps the length label when the resolver returns undefined", async () => {
    await act(async () => {
      root.render(
        <LedgerScreen
          rows={KEYED_ONLY_ROW}
          turnNumbers={TURN_NUMBERS}
          compact={false}
          theme={THEME}
          textFor={NO_TEXT}
        />,
      );
    });
    await expand();

    expect(cellText(1)).toBe("user message (18 chars)");
  });
});

/** Records what a consumer sees, so cache fills are observable. */
const seen: string[] = [];

function Probe(props: { cells: readonly TrajectoryCellProps[]; refetch: TimelineRefetch }) {
  const text = useTrajectoryText("a1", props.cells, props.refetch);
  seen.push(text.textFor(props.cells[0]!) ?? "<none>");
  return null;
}

describe("resolver reactivity and cache", () => {
  it("fills the cache and re-renders the consumer with the text", async () => {
    seen.length = 0;
    const refetch = vi.fn<TimelineRefetch>(async () => ({
      entries: [{ item: { type: "user_message", text: "run the test suite", messageId: "m-1" } }],
    }));

    await act(async () => {
      root.render(<Probe cells={ONE_CELL} refetch={refetch} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(refetch).toHaveBeenCalledTimes(1);
    // The last recorded value is what the consumer ended up showing: a plain
    // Map cache is invisible to React, so a version bump is what makes the
    // filled value observable at all.
    expect(seen.at(-1)).toBe("run the test suite");
  });

  it("resolves an unkeyed cell to undefined without fetching for it", async () => {
    seen.length = 0;
    const refetch = vi.fn<TimelineRefetch>(async () => ({ entries: [] }));

    await act(async () => {
      root.render(<Probe cells={ONE_UNKEYED_CELL} refetch={refetch} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(refetch).not.toHaveBeenCalled();
    expect(seen.at(-1)).toBe("<none>");
  });

  it("does not refetch when the cache is already warm", async () => {
    seen.length = 0;
    const refetch = vi.fn<TimelineRefetch>(async () => ({
      entries: [{ item: { type: "user_message", text: "run the test suite", messageId: "m-1" } }],
    }));
    await act(async () => {
      root.render(<Probe cells={ONE_CELL} refetch={refetch} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const calls = refetch.mock.calls.length;
    expect(calls).toBeGreaterThan(0);

    await act(async () => {
      root.render(<Probe cells={ONE_CELL} refetch={refetch} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(refetch.mock.calls.length).toBe(calls);
    expect(seen.at(-1)).toBe("run the test suite");
  });

  it("leaves the cell unresolved when the fetch fails, without throwing", async () => {
    seen.length = 0;
    const refetch = vi.fn<TimelineRefetch>(async () => {
      throw new Error("daemon unreachable");
    });
    await act(async () => {
      root.render(<Probe cells={ONE_CELL} refetch={refetch} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(seen.at(-1)).toBe("<none>");
  });
});
