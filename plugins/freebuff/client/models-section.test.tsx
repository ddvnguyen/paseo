import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcHandlers = vi.hoisted(() => ({
  current: {} as Record<string, (input: never) => Promise<unknown>>,
}));
const toastCalls = vi.hoisted(() => ({ show: [] as unknown[][], error: [] as unknown[][] }));

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

vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => (input: unknown) =>
    rpcHandlers.current[contract.name]?.(input as never),
}));

vi.mock("@getpaseo/plugin/client/react-native", () => ({
  useToast: () => ({
    show: (...args: unknown[]) => void toastCalls.show.push(args),
    error: (...args: unknown[]) => void toastCalls.error.push(args),
  }),
}));

vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsSection: ({ title, children }: React.PropsWithChildren<{ title: string }>) =>
    React.createElement("section", { "data-title": title }, children),
  SettingsIconRow: ({
    label,
    hint,
    children,
    trailing,
    testID,
  }: React.PropsWithChildren<{
    label: string;
    hint?: string;
    trailing?: React.ReactNode;
    testID?: string;
  }>) =>
    React.createElement(
      "div",
      { "data-testid": testID },
      React.createElement("span", { "data-slot": "label" }, label),
      hint ? React.createElement("span", { "data-slot": "hint" }, hint) : null,
      children,
      React.createElement("div", { "data-slot": "trailing" }, trailing),
    ),
  SettingsIconButton: ({
    accessibilityLabel,
    onPress,
    disabled,
    testID,
  }: {
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
        "data-testid": testID,
        disabled,
        onClick: () => {
          if (!disabled) onPress();
        },
      },
      accessibilityLabel,
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
}));

import { ModelsSection } from "./models-section";

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

const PRICED_MODELS = {
  models: [
    {
      id: "z-ai/glm-5.3-flash",
      name: "GLM 5.3 Flash",
      tagline: "Deep reasoning",
      priceFreebucks: 5,
      sessionLifetimeLabel: "1h",
      priceNotices: "peak hours",
      enabled: true,
    },
    {
      id: "mimo/mimo-v2.5",
      name: "MiMo 2.6 Flash",
      tagline: "Balanced",
      sessionLifetimeLabel: "1h",
      enabled: false,
    },
  ],
};

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
  rpcHandlers.current = {};
  toastCalls.show = [];
  toastCalls.error = [];
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

async function flushQueries(): Promise<void> {
  // react-query batches notifications on a timer: microtask flushes are not enough.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}

async function renderModels(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root!.render(
      <QueryClientProvider client={client}>
        <ModelsSection theme={theme} />
      </QueryClientProvider>,
    );
  });
  await flushQueries();
  return container!;
}

function click(element: Element | null): void {
  act(() => {
    element?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

describe("ModelsSection", () => {
  it("renders rows with cost details and enable switches", async () => {
    rpcHandlers.current["freebuff.models.list"] = async () => PRICED_MODELS;
    const setEnabledCalls: unknown[][] = [];
    rpcHandlers.current["freebuff.models.set-enabled"] = async (input: never) => {
      setEnabledCalls.push([input]);
      return { disabled: [] };
    };

    const view = await renderModels();

    expect(view.textContent).toContain("GLM 5.3 Flash");
    expect(view.textContent).toContain("5 Freebucks · 1h session (peak hours)");
    expect(view.textContent).toContain("price unavailable");
    const enabledSwitch = view.querySelector(
      '[data-testid="freebuff-model-enabled-z-ai/glm-5.3-flash"]',
    );
    expect(enabledSwitch?.getAttribute("aria-checked")).toBe("true");
    const disabledSwitch = view.querySelector(
      '[data-testid="freebuff-model-enabled-mimo/mimo-v2.5"]',
    );
    expect(disabledSwitch?.getAttribute("aria-checked")).toBe("false");

    click(disabledSwitch);
    await flushQueries();
    expect(setEnabledCalls).toEqual([[{ id: "mimo/mimo-v2.5", enabled: true }]]);
    expect(toastCalls.error).toEqual([]);
  });

  it("shows the modelCheck warning badge when prices are missing", async () => {
    rpcHandlers.current["freebuff.models.list"] = async () => ({
      models: [],
      modelCheck: "Server unreachable; model prices unavailable.",
    });

    const view = await renderModels();

    const badge = view.querySelector('[data-testid="freebuff-models-warning"]');
    expect(badge?.textContent).toContain("Server unreachable; model prices unavailable.");
  });

  it("toasts the RPC error when disabling the last enabled model fails", async () => {
    rpcHandlers.current["freebuff.models.list"] = async () => PRICED_MODELS;
    rpcHandlers.current["freebuff.models.set-enabled"] = async () => {
      throw new Error('Cannot disable "z-ai/glm-5.3-flash": at least one model must stay enabled.');
    };

    const view = await renderModels();

    click(view.querySelector('[data-testid="freebuff-model-enabled-z-ai/glm-5.3-flash"]'));
    await flushQueries();
    expect(toastCalls.error).toEqual([
      ['Cannot disable "z-ai/glm-5.3-flash": at least one model must stay enabled.'],
    ]);
  });
});
