import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const layoutState = vi.hoisted(() => ({ compact: false }));

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    fontSize: { sm: 12, base: 14 },
    fontWeight: { normal: "normal" as const },
    colors: {
      foreground: "#foreground",
      foregroundMuted: "#muted",
      statusDanger: "#danger",
      border: "#border",
      surface1: "#surface1",
      interactionHighlight: "rgba(0, 0, 0, 0.06)",
    },
    iconSize: { sm: 14 },
    borderRadius: { md: 6, lg: 8 },
    borderWidth: { 1: 1 },
    opacity: { 50: 0.5 },
  },
}));

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle).filter(Boolean));
  if (typeof style === "object") return style as Record<string, unknown>;
  return {};
}

vi.mock("react-native", () => {
  const stubNull = () => null;
  return {
    Platform: {
      OS: "web",
      select: (options: Record<string, unknown>) => options.web ?? options.default,
    },
    Dimensions: {
      get: () => ({ width: 1024, height: 768 }),
    },
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: (style: unknown) => flattenStyle(style),
    },
    View: ({
      children,
      testID,
      style,
      ...props
    }: React.PropsWithChildren<{ testID?: string; style?: unknown }>) =>
      React.createElement(
        "div",
        { ...props, "data-testid": testID, style: flattenStyle(style) },
        children,
      ),
    Text: ({
      children,
      style,
      accessibilityRole,
    }: React.PropsWithChildren<{ style?: unknown; accessibilityRole?: string }>) => {
      const resolved = flattenStyle(style);
      return React.createElement(
        "span",
        { "data-color": resolved.color, role: accessibilityRole },
        children,
      );
    },
    Pressable: ({
      children,
      onPress,
      disabled,
      accessibilityLabel,
      accessibilityRole,
      testID,
      style,
    }: React.PropsWithChildren<{
      onPress?: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      testID?: string;
      style?: unknown;
    }>) =>
      React.createElement(
        "button",
        {
          type: "button",
          "aria-label": accessibilityLabel,
          role: accessibilityRole,
          disabled,
          "data-testid": testID,
          style: flattenStyle(typeof style === "function" ? style({ pressed: false }) : style),
          onClick: () => {
            if (!disabled) onPress?.();
          },
        },
        typeof children === "function"
          ? (children as (state: { pressed: boolean }) => React.ReactNode)({ pressed: false })
          : children,
      ),
    Switch: stubNull,
    TextInput: stubNull,
    ScrollView: stubNull,
    FlatList: stubNull,
    Modal: stubNull,
    ActivityIndicator: stubNull,
    Image: stubNull,
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (value: typeof theme) => unknown) => factory(theme),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({ uniProps, ...props }: Record<string, unknown>) => {
      const themedProps =
        typeof uniProps === "function"
          ? (uniProps as (value: typeof theme) => Record<string, unknown>)(theme)
          : {};
      return React.createElement(Component, { ...props, ...themedProps });
    },
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
    createAnimatedComponent: (component: unknown) => component,
  },
  FadeIn: {},
  FadeOut: {},
  Easing: {
    ease: {},
    linear: {},
    in: () => ({}),
    out: () => ({}),
    inOut: () => ({}),
  },
  withTiming: (value: unknown) => value,
  withSpring: (value: unknown) => value,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  runOnJS: (fn: unknown) => fn,
  runOnUI: (fn: unknown) => fn,
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    Icon: createIcon("Icon"),
    createLucideIcon: () => createIcon("custom"),
    Info: createIcon("Info"),
    Pencil: createIcon("Pencil"),
    Trash2: createIcon("Trash2"),
  };
});

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => layoutState.compact,
}));

// Cut import chains the units under test never render.
vi.mock("@/components/ui/switch", () => ({ Switch: () => null }));
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/components/ui/form-field", () => ({ FormTextInput: () => null }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: () => null,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
}));
vi.mock("@/components/ui/dropdown-trigger", () => ({ DropdownTrigger: () => null }));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({
    children,
    enabledOnMobile,
  }: React.PropsWithChildren<{ enabledOnMobile?: boolean }>) =>
    React.createElement(
      "div",
      { "data-tooltip-enabled-on-mobile": String(enabledOnMobile) },
      children,
    ),
  TooltipTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: React.PropsWithChildren) =>
    React.createElement("span", { "data-tooltip": "content" }, children),
}));

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

import { SettingsIconButton, SettingsIconRow } from "./index";

function noop(): void {}

function pressButton(): void {
  act(() => {
    container
      ?.querySelector("button")
      ?.dispatchEvent(
        new container!.ownerDocument.defaultView!.MouseEvent("click", { bubbles: true }),
      );
  });
}

describe("SettingsIconButton", () => {
  it("renders the accessibility label as its accessible name with a web-only tooltip", () => {
    act(() =>
      root?.render(<SettingsIconButton icon="Pencil" accessibilityLabel="Rename" onPress={noop} />),
    );

    expect(container?.querySelector('button[aria-label="Rename"]')).not.toBeNull();
    expect(container?.querySelector('[data-tooltip-enabled-on-mobile="false"]')).not.toBeNull();
    expect(container?.querySelector('[data-tooltip="content"]')?.textContent).toBe("Rename");
  });

  it("fires onPress when enabled", () => {
    const onPress = vi.fn();
    act(() =>
      root?.render(
        <SettingsIconButton icon="Pencil" accessibilityLabel="Rename" onPress={onPress} />,
      ),
    );

    pressButton();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("blocks presses and dims with theme opacity when disabled", () => {
    const onPress = vi.fn();
    act(() =>
      root?.render(
        <SettingsIconButton icon="Pencil" accessibilityLabel="Rename" onPress={onPress} disabled />,
      ),
    );

    const button = container?.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    pressButton();
    expect(onPress).not.toHaveBeenCalled();
    expect(button.style.opacity).toBe("0.5");
  });

  it("paints the destructive variant in the danger token", () => {
    act(() =>
      root?.render(
        <SettingsIconButton icon="Trash2" accessibilityLabel="Remove" onPress={noop} destructive />,
      ),
    );

    expect(container?.querySelector('[data-icon="Trash2"]')?.getAttribute("color")).toBe("#danger");
  });

  it("paints the default variant muted", () => {
    act(() =>
      root?.render(<SettingsIconButton icon="Pencil" accessibilityLabel="Rename" onPress={noop} />),
    );

    expect(container?.querySelector('[data-icon="Pencil"]')?.getAttribute("color")).toBe("#muted");
  });

  it("renders nothing for an unknown icon name without breaking the button", () => {
    const onPress = vi.fn();
    act(() =>
      root?.render(
        // "Icon" is the lucide base export, never a renderable icon name.
        <SettingsIconButton icon="Icon" accessibilityLabel="Rename" onPress={onPress} />,
      ),
    );

    expect(container?.querySelector("[data-icon]")).toBeNull();
    expect(container?.querySelector('button[aria-label="Rename"]')).not.toBeNull();
  });
});

describe("SettingsIconRow", () => {
  beforeEach(() => {
    layoutState.compact = false;
  });

  function renderRow(trailing?: React.ReactNode): void {
    act(() =>
      root?.render(
        <SettingsIconRow
          icon="Pencil"
          label="Account"
          hint="Freebuff account"
          testID="row"
          trailing={trailing}
        >
          <span data-content="body">body</span>
        </SettingsIconRow>,
      ),
    );
  }

  it("lays label, content, and trailing controls inline on wide layouts", () => {
    renderRow(<SettingsIconButton icon="Pencil" accessibilityLabel="Rename" onPress={noop} />);

    const row = container?.querySelector('[data-testid="row"]') as HTMLElement;
    expect(row.style.flexDirection).toBe("row");
    expect(container?.textContent).toContain("Account");
    expect(container?.textContent).toContain("Freebuff account");
    expect(container?.querySelector('[data-content="body"]')).not.toBeNull();
    const trailing = container?.querySelector('[data-testid="row-trailing"]') as HTMLElement;
    expect(trailing).not.toBeNull();
    expect(trailing.style.flexDirection).toBe("row");
    expect(trailing.querySelector('button[aria-label="Rename"]')).not.toBeNull();
  });

  it("stacks the trailing slot below the content on compact layouts", () => {
    layoutState.compact = true;
    renderRow(<SettingsIconButton icon="Pencil" accessibilityLabel="Rename" onPress={noop} />);

    const row = container?.querySelector('[data-testid="row"]') as HTMLElement;
    expect(row.style.flexDirection).toBe("column");
    const trailing = container?.querySelector('[data-testid="row-trailing"]') as HTMLElement;
    expect(trailing).not.toBeNull();
    expect(trailing.querySelector('button[aria-label="Rename"]')).not.toBeNull();
  });

  it("omits the trailing slot when no controls are given", () => {
    renderRow(undefined);

    expect(container?.querySelector('[data-testid="row-trailing"]')).toBeNull();
  });

  it("renders row errors as an alert", () => {
    act(() =>
      root?.render(
        <SettingsIconRow icon="Pencil" label="Account" error="Keep it short" testID="row" />,
      ),
    );

    expect(container?.querySelector('[role="alert"]')?.textContent).toBe("Keep it short");
  });
});
