import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inputHandlers = vi.hoisted(() => ({
  current: {} as Record<string, (text: string) => void>,
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
}));

vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsCard: ({ children, testID }: React.PropsWithChildren<{ testID?: string }>) =>
    React.createElement("div", { "data-testid": testID }, children),
  SettingsIconRow: ({
    label,
    hint,
    error,
    children,
    trailing,
    testID,
  }: React.PropsWithChildren<{
    label: string;
    hint?: string;
    error?: string | null;
    trailing?: React.ReactNode;
    testID?: string;
  }>) =>
    React.createElement(
      "div",
      { "data-testid": testID },
      React.createElement("span", { "data-slot": "label" }, label),
      hint ? React.createElement("span", { "data-slot": "hint" }, hint) : null,
      error ? React.createElement("span", { role: "alert" }, error) : null,
      children,
      React.createElement(
        "div",
        { "data-testid": testID ? `${testID}-trailing` : undefined },
        trailing,
      ),
    ),
  SettingsIconButton: ({
    icon,
    accessibilityLabel,
    onPress,
    disabled,
    testID,
  }: {
    icon: string;
    accessibilityLabel: string;
    onPress: () => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        "data-icon": icon,
        "data-testid": testID,
        disabled,
        onClick: () => {
          if (!disabled) onPress();
        },
      },
      icon,
    ),
  SettingsSwitch: ({
    label,
    value,
    onValueChange,
    disabled,
    testID,
  }: {
    label: string;
    value: boolean;
    onValueChange: (value: boolean) => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        role: "switch",
        "aria-label": label,
        "aria-checked": String(value),
        "data-testid": testID,
        disabled,
        onClick: () => {
          if (!disabled) onValueChange(!value);
        },
      },
      label,
    ),
  SettingsInput: ({
    label,
    initialValue,
    placeholder,
    onChangeText,
  }: {
    label: string;
    initialValue?: string;
    placeholder?: string;
    onChangeText: (text: string) => void;
  }) => {
    inputHandlers.current[label] = onChangeText;
    return React.createElement("input", {
      "aria-label": label,
      defaultValue: initialValue,
      placeholder,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
    });
  },
}));

import { AccountRow } from "./account-row";

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

function buildAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "work",
    label: "Work",
    isDefault: false,
    authenticated: true,
    managed: true,
    email: "duc@x.y",
    name: "Duc",
    seat: { state: "none" as const },
    status: { dailyRemaining: 20, dailyLimit: 25, walletBalance: 3 },
    cliSettings: {
      mode: "LITE",
      freebuffModel: "z-ai/glm-5.3-flash",
      adsEnabled: false,
    },
    ...overrides,
  };
}

interface RowCallbacks {
  onEndSession: (id: string) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onMoveUp: (id: string) => void;
  canMoveUp: boolean;
}

function callbacks(options: { canMoveUp?: boolean } = {}): RowCallbacks & {
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {
    onEndSession: [],
    onDelete: [],
    onSetDefault: [],
    onRename: [],
    onMoveUp: [],
  };
  return {
    calls,
    canMoveUp: options.canMoveUp ?? false,
    onEndSession: (...args: unknown[]) => void calls.onEndSession.push(args),
    onDelete: (...args: unknown[]) => void calls.onDelete.push(args),
    onSetDefault: (...args: unknown[]) => void calls.onSetDefault.push(args),
    onRename: (...args: unknown[]) => void calls.onRename.push(args),
    onMoveUp: (...args: unknown[]) => void calls.onMoveUp.push(args),
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
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function renderRow(
  account: ReturnType<typeof buildAccount>,
  compact: boolean,
  handlers: RowCallbacks,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <AccountRow
          account={account}
          theme={theme}
          compact={compact}
          endSessionBusy={false}
          deleteBusy={false}
          setDefaultBusy={false}
          renameBusy={false}
          onEndSession={handlers.onEndSession}
          onDelete={handlers.onDelete}
          onSetDefault={handlers.onSetDefault}
          onRename={handlers.onRename}
          onMoveUp={handlers.onMoveUp}
          canMoveUp={handlers.canMoveUp}
        />
      </QueryClientProvider>,
    );
  });
  return container!;
}

function byAriaLabel(scope: ParentNode, label: string): HTMLElement | null {
  return scope.querySelector(`[aria-label="${label}"]`);
}

function click(element: Element | null): void {
  act(() => {
    element?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

function typeText(label: string, value: string): void {
  act(() => {
    inputHandlers.current[label]?.(value);
  });
}

describe("AccountRow wide layout", () => {
  it("shows identity, quota, seat, and inline actions on one row", () => {
    const handlers = callbacks();
    const view = renderRow(buildAccount(), false, handlers);

    expect(view.textContent).toContain("duc@x.y · Duc");
    // Owner directive: single-line quota text.
    expect(view.textContent).toContain("20% used · 20/25 daily");
    expect(view.textContent).toContain("No active session");
    expect(byAriaLabel(view, "Rename Work")).not.toBeNull();
    expect(byAriaLabel(view, "Remove Work")).not.toBeNull();
    // Seat is idle: no end-session action.
    expect(byAriaLabel(view, "End session for Work")).toBeNull();
    // Wide layout renders actions inline, not behind a menu.
    expect(byAriaLabel(view, "Actions for Work")).toBeNull();
  });

  it("marks the default row with an on, disabled switch and no trash", () => {
    const handlers = callbacks();
    const view = renderRow(
      buildAccount({ isDefault: true, seat: { state: "active" } }),
      false,
      handlers,
    );

    const defaultSwitch = view.querySelector('[data-testid="freebuff-default-work"]');
    expect(defaultSwitch?.getAttribute("aria-checked")).toBe("true");
    expect((defaultSwitch as HTMLButtonElement).disabled).toBe(true);
    expect(byAriaLabel(view, "Remove Work")).toBeNull();
    expect(byAriaLabel(view, "End session for Work")).not.toBeNull();
  });

  it("flips a non-default Default switch on and reports the account", () => {
    const handlers = callbacks();
    const view = renderRow(buildAccount(), false, handlers);

    const defaultSwitch = view.querySelector('[data-testid="freebuff-default-work"]');
    expect(defaultSwitch?.getAttribute("aria-checked")).toBe("false");
    click(defaultSwitch);
    expect(handlers.calls.onSetDefault).toEqual([["work"]]);
  });

  it("renames inline with confirm and cancel", () => {
    const handlers = callbacks();
    const view = renderRow(buildAccount(), false, handlers);

    click(byAriaLabel(view, "Rename Work"));
    const input = view.querySelector('input[aria-label="New label"]');
    expect(input).not.toBeNull();
    typeText("New label", "Work II");
    click(byAriaLabel(view, "Save label"));
    expect(handlers.calls.onRename).toEqual([["work", "Work II"]]);

    click(byAriaLabel(view, "Rename Work"));
    click(byAriaLabel(view, "Cancel rename"));
    expect(handlers.calls.onRename).toHaveLength(1);
  });

  it("fires end-session and remove icon actions", () => {
    const handlers = callbacks();
    const view = renderRow(buildAccount({ seat: { state: "active" } }), false, handlers);

    click(byAriaLabel(view, "End session for Work"));
    expect(handlers.calls.onEndSession).toEqual([["work"]]);
    click(byAriaLabel(view, "Remove Work"));
    expect(handlers.calls.onDelete).toEqual([["work"]]);
  });

  it("toggles the collapsible CLI preferences body", () => {
    const handlers = callbacks();
    const view = renderRow(buildAccount(), false, handlers);

    expect(view.textContent).not.toContain("Mode: LITE");
    click(byAriaLabel(view, "Show CLI preferences"));
    expect(view.textContent).toContain("Mode: LITE");
    expect(view.textContent).toContain("Model: z-ai/glm-5.3-flash");
  });

  it("puts the trash on the bottom action line, right-aligned (owner layout)", () => {
    const handlers = callbacks();
    const view = renderRow(buildAccount(), false, handlers);

    const bottomLine = view.querySelector('[data-testid="freebuff-bottom-actions-work"]');
    expect(bottomLine).not.toBeNull();
    // The trash lives inside the bottom action line, not the trailing slot.
    expect(bottomLine?.querySelector('[aria-label="Remove Work"]')).not.toBeNull();
    const trailing = view.querySelector('[data-testid="freebuff-account-row-work-trailing"]');
    expect(trailing?.querySelector('[aria-label="Remove Work"]')).toBeNull();
  });

  it("renders the Default switch in the trailing slot at the end of the name line", () => {
    const handlers = callbacks();
    const view = renderRow(buildAccount(), false, handlers);

    const trailing = view.querySelector('[data-testid="freebuff-account-row-work-trailing"]');
    expect(trailing?.querySelector('[data-testid="freebuff-default-work"]')).not.toBeNull();
    expect(trailing?.querySelector('[aria-label="Rename Work"]')).not.toBeNull();
  });

  it("offers Move up only when canMoveUp is set and fires with the account id", () => {
    const handlers = callbacks({ canMoveUp: true });
    const view = renderRow(buildAccount(), false, handlers);

    click(byAriaLabel(view, "Move Work up"));
    expect(handlers.calls.onMoveUp).toEqual([["work"]]);

    const hidden = callbacks({ canMoveUp: false });
    const view2 = renderRow(buildAccount(), false, hidden);
    expect(byAriaLabel(view2, "Move Work up")).toBeNull();
  });
});

describe("AccountRow compact layout", () => {
  it("hides actions behind the menu until opened", () => {
    const handlers = callbacks();
    const view = renderRow(buildAccount({ seat: { state: "active" } }), true, handlers);

    expect(view.textContent).toContain("duc@x.y · Duc");
    const menu = byAriaLabel(view, "Actions for Work");
    expect(menu).not.toBeNull();
    expect(byAriaLabel(view, "Remove Work")).toBeNull();

    click(menu);
    expect(byAriaLabel(view, "Remove Work")).not.toBeNull();
    expect(byAriaLabel(view, "End session for Work")).not.toBeNull();
    click(byAriaLabel(view, "Remove Work"));
    expect(handlers.calls.onDelete).toEqual([["work"]]);
  });
});
