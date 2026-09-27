/** Component tests for the row inspector (wide + compact) over static fixtures. */

// @vitest-environment jsdom
// @ts-expect-error repo pattern: expose act() support flag before react loads
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  StyleSheet: {
    create: (styles: unknown) => styles,
    hairlineWidth: 1,
    absoluteFillObject: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
    flatten: (style: unknown) => style,
  },
  View: ({ children, testID }: React.PropsWithChildren<{ testID?: string }>) =>
    React.createElement("div", { "data-testid": testID }, children),
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
import { FIXTURE_ROWS } from "./fixtures.js";
import { TrajectoryInspector } from "./trajectory-inspector.js";

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
let closeCount = 0;

function noop(): void {}
function countClose(): void {
  closeCount += 1;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(row: TrajectoryFoldRow | null, overrides: { compact?: boolean } = {}): void {
  act(() => {
    root.render(
      <TrajectoryInspector
        row={row}
        compact={overrides.compact === true}
        theme={THEME}
        onClose={noop}
      />,
    );
  });
}

function text(testID: string): string | null {
  // Field rows wrap label + value; the value is the last child. Bare Text
  // nodes (label) have no element children and read directly.
  const node = document.querySelector(`[data-testid="${testID}"]`);
  const value = node?.lastElementChild ?? node;
  return value?.textContent ?? null;
}

const TOOL_ROW = FIXTURE_ROWS[2];
const ERROR_ROW = FIXTURE_ROWS[3];
const IN_FLIGHT_ROW = FIXTURE_ROWS[7];

describe("trajectory inspector", () => {
  it("renders nothing when no row is selected (closed by default)", () => {
    render(null);
    expect(document.querySelector('[data-testid="trajectory-inspector"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("shows tool-row facts: seq, turn, step, duration, output, status, call", () => {
    render(TOOL_ROW);
    expect(text("inspector-label")).toBe("shell · npm test");
    expect(text("inspector-seq")).toBe("#2");
    expect(text("inspector-turn")).toBe("t1");
    expect(text("inspector-step")).toBe("Step 1");
    expect(text("inspector-duration")).toBe("2,400 ms");
    expect(text("inspector-output")).toContain("characters: 1,520");
    // Fixture carries no failure flag: status is unknown, not "ok".
    expect(text("inspector-error")).toBe("—");
    expect(text("inspector-call")).toBe("c1");
  });

  it("marks failed tool rows as error", () => {
    render(ERROR_ROW);
    expect(text("inspector-label")).toBe("read · src/app.ts");
    expect(text("inspector-error")).toBe("error");
  });

  it("renders an em dash for in-flight duration", () => {
    render(IN_FLIGHT_ROW);
    expect(text("inspector-duration")).toBe("—");
  });

  it("shows token buckets for message rows with usage", () => {
    const message: TrajectoryFoldRow = {
      seq: 41,
      timeMs: null,
      kind: "message",
      label: "assistant message",
      durationMs: 700,
      turnId: "t2",
      step: 1,
      usage: { input: 1200, cacheRead: 300, cacheWrite: null, output: 84, think: null },
    };
    render(message);
    expect(text("inspector-tokens")).toBe("token: In 1,200(300) / out 84");
    // No tool-only fields on message rows.
    expect(document.querySelector('[data-testid="inspector-output"]')).toBeNull();
    expect(document.querySelector('[data-testid="inspector-call"]')).toBeNull();
  });

  it("renders the same fields in compact (overlay) as wide (dock)", () => {
    render(TOOL_ROW, { compact: true });
    expect(text("inspector-label")).toBe("shell · npm test");
    expect(text("inspector-seq")).toBe("#2");
    expect(text("inspector-duration")).toBe("2,400 ms");
    expect(text("inspector-call")).toBe("c1");
  });

  it("close button fires onClose", () => {
    closeCount = 0;
    act(() => {
      root.render(
        <TrajectoryInspector row={TOOL_ROW} compact={false} theme={THEME} onClose={countClose} />,
      );
    });
    act(() =>
      (document.querySelector('[data-testid="inspector-close"]') as HTMLButtonElement).click(),
    );
    expect(closeCount).toBe(1);
  });
});
