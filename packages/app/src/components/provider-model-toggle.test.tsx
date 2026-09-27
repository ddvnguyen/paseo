/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDisabledModelsStore } from "@/stores/disabled-models-store";
import "@/i18n/i18next";
import { ModelDisableSwitch } from "./provider-model-toggle";

// @ts-expect-error repo pattern: expose act() support flag for react-dom test renders
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", () => ({
  View: ({ children }: React.PropsWithChildren) => React.createElement("div", null, children),
  Text: ({ children }: React.PropsWithChildren) => React.createElement("span", null, children),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
    disabled,
    accessibilityLabel,
  }: {
    value: boolean;
    onValueChange?: (value: boolean) => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) =>
    React.createElement("button", {
      type: "button",
      "aria-label": accessibilityLabel,
      "aria-checked": value,
      "aria-disabled": disabled,
      onClick: () => onValueChange?.(!value),
    }),
}));

const SERVER = "host-a";
const PROVIDER = "claude";
const CATALOG = ["m1", "m2"];

let container: HTMLDivElement;
let root: Root;

function render(modelId: string): void {
  act(() => {
    root.render(
      <ModelDisableSwitch
        serverId={SERVER}
        provider={PROVIDER}
        modelId={modelId}
        modelLabel={modelId}
        catalogIds={CATALOG}
      />,
    );
  });
}

function toggle(): HTMLButtonElement {
  const button = container.querySelector("button");
  if (!button) throw new Error("toggle switch not rendered");
  return button as HTMLButtonElement;
}

beforeEach(() => {
  useDisabledModelsStore.setState({ disabledByServerProvider: {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ModelDisableSwitch", () => {
  it("starts ON and writes the disable set on toggle", () => {
    render("m1");
    expect(toggle().getAttribute("aria-checked")).toBe("true");

    act(() => toggle().click());
    expect(useDisabledModelsStore.getState().isModelDisabled(SERVER, PROVIDER, "m1")).toBe(true);
    expect(toggle().getAttribute("aria-checked")).toBe("false");

    act(() => toggle().click());
    expect(useDisabledModelsStore.getState().isModelDisabled(SERVER, PROVIDER, "m1")).toBe(false);
  });

  it("blocks turning OFF the last enabled model with a visible hint", () => {
    useDisabledModelsStore.setState({
      disabledByServerProvider: { [SERVER]: { [PROVIDER]: ["m1"] } },
    });
    render("m2");

    expect(toggle().getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent).toContain("At least one model stays enabled");
  });

  it("keeps the switch interactive for re-enabling a disabled model", () => {
    useDisabledModelsStore.setState({
      disabledByServerProvider: { [SERVER]: { [PROVIDER]: ["m1"] } },
    });
    render("m1");

    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().getAttribute("aria-disabled")).toBe("false");
  });
});
