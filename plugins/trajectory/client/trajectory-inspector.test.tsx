/** Component tests for the row inspector (wide + compact) over static fixtures. */

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
/**
 * A call whose result never arrived: the one row the ledger treats as still
 * running. Built here rather than taken from the shared fixtures so its start is
 * relative to the test's own clock, which is what a live elapsed reads against.
 */
const OPEN_ROW: TrajectoryFoldRow = {
  seq: 8,
  timeMs: Date.now() - 5_000,
  kind: "tool",
  label: "bash · npm run build",
  durationMs: null,
  open: true,
  callId: "c9",
  turnId: "t3",
  step: 1,
};

const MESSAGE_ROW: TrajectoryFoldRow = {
  seq: 41,
  timeMs: Date.parse("2026-10-03T00:00:00Z"),
  kind: "message",
  label: "assistant message",
  durationMs: 700,
  turnId: "t2",
  step: 1,
  usage: { input: 1200, cacheRead: 300, cacheWrite: null, output: 84, think: 12 },
};

describe("trajectory inspector", () => {
  it("renders nothing when no row is selected (closed by default)", () => {
    render(null);
    expect(document.querySelector('[data-testid="trajectory-inspector"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("shows a tool row's identity, timing, payload and call", () => {
    render(TOOL_ROW);
    expect(text("inspector-label")).toBe("shell · npm test");
    expect(text("inspector-seq")).toBe("#2");
    expect(text("inspector-turn")).toBe("t1");
    // 2.4s floors to "2s" — the panel shares the ledger's formatter.
    expect(text("inspector-duration")).toBe("2s");
    expect(text("inspector-status-value")).toBe("Completed");
    expect(text("inspector-timing-source")).toBe("Recorder clock (call → result)");
    // dsh's Payload, at the fidelity the ledger records: the arguments summary.
    expect(text("inspector-args")).toBe("npm test");
    expect(text("inspector-output")).toContain("1,520 chars");
    expect(text("inspector-call")).toBe("c1");
    // dsh gives every tool record a Schema tab; ours states the gap instead of
    // leaving the reader to guess whether the panel is simply missing it.
    expect(text("inspector-schema")).toBe("not recorded");
  });

  it("says when the row started, and offers the unix stamp", () => {
    render(TOOL_ROW);
    const started = document.querySelector('[data-testid="inspector-started-value"]');
    const local = started?.textContent ?? "";
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    act(() =>
      (
        document.querySelector('[data-testid="inspector-started-toggle"]') as HTMLButtonElement
      ).click(),
    );
    const unix = document.querySelector('[data-testid="inspector-started-value"]')?.textContent;
    expect(unix).toBe(((TOOL_ROW.timeMs ?? 0) / 1_000).toFixed(3));
  });

  it("marks a failed tool row as Failed", () => {
    render(ERROR_ROW);
    expect(text("inspector-label")).toBe("read · src/app.ts");
    expect(text("inspector-status-value")).toBe("Failed");
  });

  it("renders an em dash for a duration that was never measured", () => {
    // The fixture's third tool row settled with no recorded duration (its call
    // start was never observed), which is not the same as still running.
    render(FIXTURE_ROWS[7]);
    expect(text("inspector-duration")).toBe("—");
    expect(text("inspector-timing-source")).toBe("Not available");
    expect(text("inspector-status-value")).toBe("Completed");
  });

  it("counts an open row up live instead of showing an em dash", () => {
    vi.useFakeTimers();
    try {
      render(OPEN_ROW);
      expect(text("inspector-status-value")).toBe("Pending");
      expect(text("inspector-timing-source")).toBe("Recorder clock (running)");
      expect(text("inspector-duration")).toBe("5s");
      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      expect(text("inspector-duration")).toBe("9s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a message row the assistant timing block and the token split", () => {
    render(MESSAGE_ROW);
    // The assistant panel replaces the plain duration trio on a message row: a
    // tool call has no first token, so those fields would be noise on it.
    expect(document.querySelector('[data-testid="inspector-duration"]')).toBeNull();
    // 700ms of recorded own duration, in dsh's ms formatter.
    expect(text("inspector-total")).toBe("700 ms");
    expect(text("inspector-ttft")).toBe("First token unavailable");
    expect(text("inspector-generation")).toBe("First token unavailable");
    expect(text("inspector-throughput")).toBe("First token unavailable");
    expect(text("inspector-tokens")).toBe("In 1,200(300) / out 84");
    expect(text("inspector-output")).toBe("84 tok");
    expect(text("inspector-reasoning")).toBe("12 tok");
    expect(text("inspector-content")).toBe("72 tok");
    // No tool-only fields on message rows.
    expect(document.querySelector('[data-testid="inspector-call"]')).toBeNull();
    expect(document.querySelector('[data-testid="inspector-args"]')).toBeNull();
  });

  it("names the missing start before the missing first token, in dsh's order", () => {
    // dsh checks the step start first, so a row with no absolute stamp says so
    // rather than blaming the first token it also has no stamp for.
    render({ ...MESSAGE_ROW, timeMs: null });
    expect(text("inspector-total")).toBe("700 ms");
    expect(text("inspector-ttft")).toBe("Step start unavailable");
  });

  it("says when a derived row was inferred rather than observed", () => {
    render({ ...TOOL_ROW, kind: "llm", label: "llm round 2 · consumed 3 results", derived: true });
    expect(text("inspector-origin")).toBe("derived by the recorder");
    expect(document.querySelector('[data-testid="inspector-args"]')).toBeNull();
  });

  it("renders the same fields in compact (overlay) as wide (dock)", () => {
    render(TOOL_ROW, { compact: true });
    expect(text("inspector-label")).toBe("shell · npm test");
    expect(text("inspector-seq")).toBe("#2");
    expect(text("inspector-duration")).toBe("2s");
    expect(text("inspector-status-value")).toBe("Completed");
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
