/** Component tests for the ledger cell primitives (wide + compact). */

// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({
    children,
    testID,
    style,
  }: React.PropsWithChildren<{ testID?: string; style?: unknown }>) =>
    React.createElement(
      "div",
      { "data-testid": testID, "data-style": JSON.stringify(style) },
      children,
    ),
  Text: ({
    children,
    testID,
    numberOfLines,
    style,
  }: React.PropsWithChildren<{ testID?: string; numberOfLines?: number; style?: unknown }>) =>
    React.createElement(
      "span",
      {
        "data-testid": testID,
        "data-lines": numberOfLines,
        "data-style": JSON.stringify(style ?? null),
      },
      children,
    ),
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

import {
  CharsText,
  DurationText,
  KindTag,
  LedgerColumnHeader,
  TimeText,
  TokenText,
  TrajectoryCellRow,
  cellContext,
  rowSurface,
  columnLayout,
  formatClockTime,
  kindRailColor,
} from "./ledger-cells.js";
import type { TrajectoryCellProps } from "../shared/dsh/record.js";

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

function render(node: React.ReactElement): void {
  act(() => root.render(node));
}

function cell(overrides: Partial<TrajectoryCellProps> = {}): TrajectoryCellProps {
  return {
    index: 1,
    kind: "tool",
    text: "shell · npm test",
    timeSeconds: 1.5,
    ...overrides,
  };
}

describe("ledger cells", () => {
  it("renders kind tag text wide and icon compact", () => {
    render(<KindTag kind="tool" compact={false} theme={THEME} />);
    expect(document.querySelector('[data-testid="kind-tag-tool"]')?.textContent).toBe("tool");
    render(<KindTag kind="tool" compact theme={THEME} />);
    expect(document.querySelector('[data-testid="kind-tag-tool"]')?.textContent).toBe("T");
  });

  it("renders duration through the ported formatter and the em dash when unknown", () => {
    render(<DurationText timeSeconds={1.5} theme={THEME} />);
    expect(document.querySelector('[data-testid="duration-text"]')?.textContent).toBe("1,500 ms");
    render(<DurationText timeSeconds={null} theme={THEME} />);
    expect(document.querySelector('[data-testid="duration-text"]')?.textContent).toBe("—");
  });

  it("renders token columns with cache and the em dash form when unreported", () => {
    render(<TokenText input={1234} cacheRead={567} output={89} theme={THEME} />);
    expect(document.querySelector('[data-testid="token-text"]')?.textContent).toBe(
      "In 1,234(567) / out 89",
    );
    render(<TokenText theme={THEME} />);
    expect(document.querySelector('[data-testid="token-text"]')?.textContent).toBe("token: —");
  });

  it("renders characters count and the em dash when unknown", () => {
    render(<CharsText outputChars={1520} theme={THEME} />);
    expect(document.querySelector('[data-testid="chars-text"]')?.textContent).toBe("1,520 chars");
    render(<CharsText outputChars={null} theme={THEME} />);
    expect(document.querySelector('[data-testid="chars-text"]')?.textContent).toBe("chars: —");
  });

  it("renders a cell row with tag, label, metrics, and error tint", () => {
    render(<TrajectoryCellRow cell={cell()} compact={false} theme={THEME} testID="cell-1" />);
    expect(document.querySelector('[data-testid="cell-1"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="kind-tag-tool"]')?.textContent).toBe("tool");
    expect(document.querySelector('[data-testid="duration-text"]')?.textContent).toBe("1,500 ms");
    render(
      <TrajectoryCellRow
        cell={cell({ isError: true, text: "read" })}
        compact
        theme={THEME}
        testID="cell-2"
      />,
    );
    expect(document.querySelector('[data-testid="kind-tag-tool"]')?.textContent).toBe("T");
    expect(document.querySelector('[data-testid="cell-2"]')?.getAttribute("data-style")).toContain(
      "#111",
    );
  });
  // --- C4: kind rails and the success glyph -------------------------------

  it("maps every kind to a rail colour from the existing theme tokens", () => {
    // No new colors: every rail must be one of the eleven plugin tokens.
    const tokens = new Set(Object.values(THEME.colors));
    for (const kind of [
      "system",
      "user",
      "context",
      "compacted",
      "message",
      "tool",
      "subtool",
    ] as const) {
      const color = kindRailColor(THEME, kind, false);
      expect(tokens.has(color)).toBe(true);
    }
  });

  it("lets an error override its kind's rail colour", () => {
    expect(kindRailColor(THEME, "tool", true)).toBe(THEME.colors.statusDanger);
    expect(kindRailColor(THEME, "message", true)).toBe(THEME.colors.statusDanger);
    // And a non-error row is not the danger colour.
    expect(kindRailColor(THEME, "tool", false)).not.toBe(THEME.colors.statusDanger);
  });

  it("renders a per-kind rail on the cell row", () => {
    render(<TrajectoryCellRow cell={cell({ kind: "message" })} compact={false} theme={THEME} />);
    const rail = document.querySelector('[data-testid="kind-rail-message"]');
    expect(rail).not.toBeNull();
    const style = JSON.parse(rail?.getAttribute("data-style") ?? "[]");
    const merged = Object.assign({}, ...(Array.isArray(style) ? style : [style]));
    expect(merged.backgroundColor).toBe(THEME.colors.accent);
  });

  it("puts a tool row's result size and runtime in the STATS column", () => {
    render(
      <TrajectoryCellRow
        cell={cell({ kind: "tool", result: "1520" })}
        compact={false}
        theme={THEME}
      />,
    );
    expect(document.querySelector('[data-testid="chars-text"]')?.textContent).toBe("1,520 chars");
    expect(document.querySelector('[data-testid="duration-text"]')?.textContent).toBe("1,500 ms");
  });

  it("reports the em dash for a tool row whose size and runtime are unknown", () => {
    render(
      <TrajectoryCellRow
        cell={cell({ kind: "tool", timeSeconds: null })}
        compact={false}
        theme={THEME}
      />,
    );
    expect(document.querySelector('[data-testid="chars-text"]')?.textContent).toBe("chars: —");
    expect(document.querySelector('[data-testid="duration-text"]')?.textContent).toBe("—");
  });

  it("puts a user row's prompt characters in the STATS column", () => {
    render(
      <TrajectoryCellRow
        cell={cell({ kind: "user", text: "user message (18 chars)", textLength: 18 })}
        compact={false}
        theme={THEME}
      />,
    );
    expect(document.querySelector('[data-testid="stats-text"]')?.textContent).toBe("18 chars");
  });

  it("puts a message row's token buckets in the STATS column", () => {
    render(
      <TrajectoryCellRow
        cell={cell({ kind: "message", input: 1234, cacheRead: 567, output: 89 })}
        compact={false}
        theme={THEME}
      />,
    );
    expect(document.querySelector('[data-testid="token-text"]')?.textContent).toBe(
      "In 1,234(567) / out 89",
    );
  });

  it("reports no prompt size for a user row recorded without one", () => {
    render(
      <TrajectoryCellRow
        cell={cell({ kind: "user", text: "user message" })}
        compact={false}
        theme={THEME}
      />,
    );
    expect(document.querySelector('[data-testid="stats-text"]')?.textContent).toBe("chars: —");
  });

  it("shows resolved text in place of the length label", () => {
    render(
      <TrajectoryCellRow
        cell={cell({ kind: "user", text: "user message (18 chars)" })}
        compact={false}
        theme={THEME}
        resolvedText="run the test suite"
      />,
    );
    expect(document.querySelector('[data-testid="col-context"]')?.textContent).toBe(
      "run the test suite",
    );
  });

  it("keeps the length label when the text is not resolved", () => {
    render(
      <TrajectoryCellRow
        cell={cell({ kind: "user", text: "user message (18 chars)" })}
        compact={false}
        theme={THEME}
      />,
    );
    expect(document.querySelector('[data-testid="col-context"]')?.textContent).toBe(
      "user message (18 chars)",
    );
  });

  it("keeps the length label when the resolved text is empty", () => {
    render(
      <TrajectoryCellRow
        cell={cell({ kind: "user", text: "user message (18 chars)" })}
        compact={false}
        theme={THEME}
        resolvedText=""
      />,
    );
    expect(document.querySelector('[data-testid="col-context"]')?.textContent).toBe(
      "user message (18 chars)",
    );
  });

  it("clips the resolved text to a single line", () => {
    render(
      <TrajectoryCellRow
        cell={cell({ kind: "user", text: "user message (18 chars)" })}
        compact={false}
        theme={THEME}
        resolvedText="a very long prompt that will certainly overflow one line"
      />,
    );
    expect(document.querySelector('[data-testid="col-context"]')?.getAttribute("data-lines")).toBe(
      "1",
    );
  });

  // --- T3-B: the virtual table -------------------------------------------

  it("renders the four sticky column headers", () => {
    render(<LedgerColumnHeader compact={false} theme={THEME} />);
    for (const name of ["time", "type", "context", "stats"]) {
      expect(document.querySelector(`[data-testid="column-header-${name}"]`)?.textContent).toBe(
        name.toUpperCase(),
      );
    }
  });

  it("keeps one column layout for the header and every row", () => {
    // The header and the rows read the same widths; that shared object is the
    // only thing keeping the columns aligned.
    const wide = columnLayout(false);
    const compactColumns = columnLayout(true);
    expect(wide.time).toBeGreaterThan(0);
    expect(wide.type).toBeGreaterThan(0);
    expect(wide.stats).toBeGreaterThan(0);
    // Compact must still fit its three fixed columns inside a phone width.
    expect(compactColumns.time + compactColumns.type + compactColumns.stats).toBeLessThan(390);
    expect(compactColumns.stats).toBeLessThan(wide.stats);
  });

  it("renders the row time as HH:MM:SS and the em dash when unknown", () => {
    // 2024-01-02T03:04:05Z read back in the runner's own zone.
    const expected = new Date(Date.UTC(2024, 0, 2, 3, 4, 5)).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    expect(formatClockTime(Date.UTC(2024, 0, 2, 3, 4, 5))).toBe(
      expected.match(/(\d{1,2}:\d{2}:\d{2})/)?.[1] ?? "—",
    );
    expect(formatClockTime(null)).toBe("—");
    expect(formatClockTime(Number.NaN)).toBe("—");
    render(<TimeText startedAt={undefined} theme={THEME} />);
    expect(document.querySelector('[data-testid="time-text"]')?.textContent).toBe("—");
  });

  it("shows only the characters a message row added, never the whole message", () => {
    const message = cell({ kind: "message", deltaChars: 67, deltaStart: 1, textLength: 68 });
    const context = cellContext(message, false, "x" + "y".repeat(67));
    expect(context.startsWith("+67 chars")).toBe(true);
    // The cumulative label must not appear: one message spans many rows.
    expect(context).not.toContain("assistant message");
  });

  it("shows the delta slice of resolved text, not the full text", () => {
    const resolvedText = "0123456789";
    // This row added "234" (from offset 2, length 3).
    const context = cellContext(
      cell({ kind: "message", deltaChars: 3, deltaStart: 2, textLength: 5 }),
      false,
      resolvedText,
    );
    expect(context).toBe("+3 chars · 234");
  });

  it("falls back to the bare delta count when the text is unresolved", () => {
    const context = cellContext(
      cell({ kind: "message", deltaChars: 12, deltaStart: 4, textLength: 16 }),
      false,
      undefined,
    );
    expect(context).toBe("+12 chars");
  });

  it("shows the first line only of a multi-line delta", () => {
    const context = cellContext(
      cell({ kind: "message", deltaChars: 10, deltaStart: 0, textLength: 10 }),
      false,
      "first\nsecond",
    );
    expect(context).toBe("+10 chars · first");
  });

  it("keeps the tool CONTEXT as name · argSummary", () => {
    const context = cellContext(
      cell({ kind: "tool", text: "shell", previewMarkdown: "npm test" }),
      false,
      undefined,
    );
    expect(context).toBe("shell · npm test");
  });

  it("falls back to the length label for a message row with no delta", () => {
    // No delta means the length is unknown: the row says so rather than
    // inventing a size.
    const context = cellContext(
      cell({ kind: "message", text: "assistant message (68 chars)" }),
      false,
      undefined,
    );
    expect(context).toBe("assistant message (68 chars)");
  });

  // --- T3-D: derived round + system prompt --------------------------------

  it("gives every kind, including the derived ones, a colour from the token set", () => {
    const tokens = new Set(Object.values(THEME.colors));
    for (const kind of [
      "system",
      "user",
      "context",
      "compacted",
      "message",
      "tool",
      "subtool",
      "llm",
      "systemPrompt",
    ] as const) {
      expect(tokens.has(kindRailColor(THEME, kind, false))).toBe(true);
    }
  });

  it("keeps the derived round visually distinct from user, message, tool and error", () => {
    // The round is the one kind that borrows a colour rather than owning one,
    // so the collisions below are exactly what must NOT happen.
    const round = kindRailColor(THEME, "llm", false);
    for (const other of ["user", "message", "tool", "system"] as const) {
      expect(round).not.toBe(kindRailColor(THEME, other, false));
    }
    expect(round).not.toBe(THEME.colors.statusDanger);
    // An error still wins over the round's own colour.
    expect(kindRailColor(THEME, "llm", true)).toBe(THEME.colors.statusDanger);
  });

  it("renders a derived round row with its label and result count", () => {
    render(
      <TrajectoryCellRow
        cell={cell({ kind: "llm", text: "llm round 1 · consumed 2 results" })}
        compact={false}
        theme={THEME}
      />,
    );
    expect(document.querySelector('[data-testid="kind-tag-llm"]')?.textContent).toBe("llm");
    expect(document.querySelector('[data-testid="col-context"]')?.textContent).toBe(
      "llm round 1 · consumed 2 results",
    );
    expect(document.querySelector('[data-testid="stats-text"]')?.textContent).toBe("2 results");
  });

  it("reports an unrecognised round with an em dash rather than a zero", () => {
    render(
      <TrajectoryCellRow
        cell={cell({ kind: "llm", text: "llm round" })}
        compact={false}
        theme={THEME}
      />,
    );
    expect(document.querySelector('[data-testid="stats-text"]')?.textContent).toBe("results: —");
  });

  it("renders the system prompt row with its size-and-hash label", () => {
    render(
      <TrajectoryCellRow
        cell={cell({
          kind: "systemPrompt",
          text: "system prompt · 1,234 chars · hash abcdef123456…",
        })}
        compact={false}
        theme={THEME}
      />,
    );
    expect(document.querySelector('[data-testid="kind-tag-systemPrompt"]')?.textContent).toBe(
      "systemPrompt",
    );
    expect(document.querySelector('[data-testid="col-context"]')?.textContent).toBe(
      "system prompt · 1,234 chars · hash abcdef123456…",
    );
  });

  it("collapses both derived kinds to a single-character tag on compact", () => {
    render(<KindTag kind="llm" compact theme={THEME} />);
    expect(document.querySelector('[data-testid="kind-tag-llm"]')?.textContent).toBe("L");
    render(<KindTag kind="systemPrompt" compact theme={THEME} />);
    expect(document.querySelector('[data-testid="kind-tag-systemPrompt"]')?.textContent).toBe("P");
  });

  // --- T3 item 10: dividers, type tint, zebra -----------------------------

  function rowStyleOf(probe: TrajectoryCellProps): Record<string, unknown> {
    render(<TrajectoryCellRow cell={probe} compact={false} theme={THEME} testID="probe" />);
    return JSON.parse(
      document.querySelector('[data-testid="probe"]')?.getAttribute("data-style") ?? "{}",
    );
  }

  it("draws a hairline divider under every row", () => {
    for (const probe of [
      cell(),
      cell({ index: 2, kind: "message" }),
      cell({ index: 3, kind: "tool" }),
    ]) {
      expect(rowStyleOf(probe).borderBottomWidth).toBe(1);
      expect(rowStyleOf(probe).borderBottomColor).toBe(THEME.colors.border);
    }
  });

  it("uses only theme surface tokens for every kind's background", () => {
    const surfaces = new Set([
      "transparent",
      THEME.colors.surface0,
      THEME.colors.surface1,
      THEME.colors.surface2,
    ]);
    for (const kind of ["user", "message", "tool", "system", "llm", "systemPrompt"] as const) {
      const background = rowStyleOf(cell({ index: 1, kind })).backgroundColor;
      expect(surfaces.has(background as string)).toBe(true);
    }
  });

  it("gives each kind its own base tint", () => {
    expect(rowSurface(THEME, "user", false, 0)).toBe(THEME.colors.surface1);
    expect(rowSurface(THEME, "message", false, 0)).toBe(THEME.colors.surface0);
    expect(rowSurface(THEME, "tool", false, 0)).toBe("transparent");
    expect(rowSurface(THEME, "system", false, 0)).toBe(THEME.colors.surface2);
  });

  it("steps odd rows one level darker so adjacent rows differ", () => {
    const even = rowSurface(THEME, "message", false, 0);
    const odd = rowSurface(THEME, "message", false, 1);
    expect(odd).not.toBe(even);
    // One step, not all the way down the ladder.
    expect(even).toBe(THEME.colors.surface0);
    expect(odd).toBe(THEME.colors.surface1);
  });

  it("caps the zebra at surface2 instead of inventing a darker colour", () => {
    expect(rowSurface(THEME, "system", false, 1)).toBe(THEME.colors.surface2);
    expect(rowSurface(THEME, "llm", false, 1)).toBe(THEME.colors.surface2);
  });

  it("keeps a failed row on surface1 regardless of the zebra", () => {
    // The failure wins the background, so an error never reads as an ordinary
    // alternate row; the rail is what distinguishes it from its neighbours.
    expect(rowSurface(THEME, "message", true, 0)).toBe(THEME.colors.surface1);
    expect(rowSurface(THEME, "message", true, 1)).toBe(THEME.colors.surface1);
    expect(rowSurface(THEME, "tool", true, 1)).toBe(THEME.colors.surface1);
  });

  it("gives the sticky column header its own bottom rule", () => {
    render(<LedgerColumnHeader compact={false} theme={THEME} />);
    const style = JSON.parse(
      document.querySelector('[data-testid="ledger-column-header"]')?.getAttribute("data-style") ??
        "{}",
    );
    expect(style.borderBottomWidth).toBe(1);
    expect(style.borderBottomColor).toBe(THEME.colors.border);
  });
});
