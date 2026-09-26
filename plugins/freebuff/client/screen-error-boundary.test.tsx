import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Owner directive 2026-09-26 (freeze): when the host app build does not
 * export the UI-kit primitives the plugin renders, the plugin must fall back
 * to plain react-native elements instead of crashing with React #130, and
 * the settings screen must show an error instead of white-screening.
 */

const hostUiState = vi.hoisted(() => ({
  exports: {} as Record<string, unknown>,
}));

vi.mock("@getpaseo/plugin/client/ui", () => ({
  get SettingsIconRow() {
    return hostUiState.exports.SettingsIconRow;
  },
  get SettingsIconButton() {
    return hostUiState.exports.SettingsIconButton;
  },
  get SettingsSwitch() {
    return hostUiState.exports.SettingsSwitch;
  },
  get SettingsInput() {
    return hostUiState.exports.SettingsInput;
  },
  get SettingsCard() {
    return hostUiState.exports.SettingsCard;
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web", select: (options: Record<string, unknown>) => options.web },
  StyleSheet: { create: (styles: unknown) => styles, flatten: (style: unknown) => style },
  View: ({ children, testID }: React.PropsWithChildren<{ testID?: string }>) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({
    children,
    testID,
    accessibilityRole,
  }: React.PropsWithChildren<{ testID?: string; accessibilityRole?: string }>) =>
    React.createElement("span", { "data-testid": testID, role: accessibilityRole }, children),
  Pressable: ({
    children,
    onPress,
    disabled,
    testID,
    accessibilityLabel,
  }: React.PropsWithChildren<{
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
    accessibilityLabel?: string;
  }>) =>
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        disabled,
        onClick: () => {
          if (!disabled) onPress();
        },
      },
      children,
    ),
}));

import { AccountRow } from "./account-row";
import { ScreenErrorBoundary } from "./screen-error-boundary";

const theme = {
  colors: {
    foreground: "#fg",
    foregroundMuted: "#muted",
    border: "#border",
    accent: "#accent",
    statusWarning: "#warn",
    statusSuccess: "#ok",
  },
};

function buildAccount() {
  return {
    id: "work",
    label: "Work",
    isDefault: false,
    authenticated: true,
    managed: true,
    email: "duc@x.y",
    name: "Duc",
    seat: { state: "none" as const },
    status: { dailyRemaining: 20, dailyLimit: 25 },
    cliSettings: null,
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  hostUiState.exports = {};
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const noop = (): void => {};

function renderWithHostUi(ui: React.ReactNode): HTMLElement {
  act(() => {
    root!.render(ui);
  });
  return container!;
}

describe("missing host UI-kit primitives (React #130 guard)", () => {
  it("AccountRow renders with plain-RN fallbacks when primitives are undefined", () => {
    hostUiState.exports = {}; // no primitives exported by this host build
    const view = renderWithHostUi(
      <AccountRow
        account={buildAccount()}
        theme={theme as never}
        compact={false}
        endSessionBusy={false}
        deleteBusy={false}
        setDefaultBusy={false}
        renameBusy={false}
        onEndSession={noop}
        onDelete={noop}
        onSetDefault={noop}
        onRename={noop}
        onMoveUp={noop}
        canMoveUp={false}
      />,
    );

    expect(view.textContent).toContain("Work");
    expect(view.textContent).toContain("20% used · 20/25 daily");
    // No React crash: the row content is present.
    expect(view.textContent).toContain("No active session");
  });

  it("AccountRow still prefers the host primitives when they exist", () => {
    hostUiState.exports = {
      SettingsIconRow: ({
        label,
        testID,
      }: React.PropsWithChildren<{ label: string; testID?: string }>) =>
        React.createElement("div", { "data-testid": testID, "data-host": "row" }, label),
      SettingsIconButton: ({
        accessibilityLabel,
        testID,
      }: {
        accessibilityLabel: string;
        testID?: string;
      }) =>
        React.createElement("button", {
          type: "button",
          "aria-label": accessibilityLabel,
          "data-testid": testID,
        }),
      SettingsSwitch: ({ label, testID }: { label: string; testID?: string }) =>
        React.createElement("button", { type: "button", "data-testid": testID }, label),
      SettingsInput: ({ label }: { label: string }) =>
        React.createElement("input", { "aria-label": label }),
      SettingsCard: ({ children }: React.PropsWithChildren) =>
        React.createElement("div", null, children),
    };
    const view = renderWithHostUi(
      <AccountRow
        account={buildAccount()}
        theme={theme as never}
        compact={false}
        endSessionBusy={false}
        deleteBusy={false}
        setDefaultBusy={false}
        renameBusy={false}
        onEndSession={noop}
        onDelete={noop}
        onSetDefault={noop}
        onRename={noop}
        onMoveUp={noop}
        canMoveUp={false}
      />,
    );

    expect(view.querySelector("[data-host='row']")).not.toBeNull();
  });

  it("ScreenErrorBoundary shows the error message instead of white-screening", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    function Bomb(): never {
      throw new Error("Element type is invalid: Minified React error #130");
    }
    const view = renderWithHostUi(
      <ScreenErrorBoundary>
        <Bomb />
      </ScreenErrorBoundary>,
    );

    expect(view.textContent).toContain("Freebuff settings failed to render.");
    expect(view.textContent).toContain("Minified React error #130");
    expect(view.querySelector('[data-testid="freebuff-screen-error"]')).not.toBeNull();
    consoleError.mockRestore();
  });

  it("ScreenErrorBoundary renders children normally when nothing throws", () => {
    const view = renderWithHostUi(
      <ScreenErrorBoundary>
        <div data-testid="child">ok</div>
      </ScreenErrorBoundary>,
    );
    expect(view.querySelector('[data-testid="child"]')).not.toBeNull();
  });
});
