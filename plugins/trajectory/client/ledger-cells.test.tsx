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
  }: React.PropsWithChildren<{ testID?: string; numberOfLines?: number }>) =>
    React.createElement("span", { "data-testid": testID, "data-lines": numberOfLines }, children),
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

import { CharsText, DurationText, KindTag, TokenText, TrajectoryCellRow } from "./ledger-cells.js";
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
      "token: In 1,234(567) / out 89",
    );
    render(<TokenText theme={THEME} />);
    expect(document.querySelector('[data-testid="token-text"]')?.textContent).toBe("token: —");
  });

  it("renders characters count and the em dash when unknown", () => {
    render(<CharsText outputChars={1520} theme={THEME} />);
    expect(document.querySelector('[data-testid="chars-text"]')?.textContent).toBe(
      "characters: 1,520",
    );
    render(<CharsText outputChars={null} theme={THEME} />);
    expect(document.querySelector('[data-testid="chars-text"]')?.textContent).toBe("characters: —");
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
});
