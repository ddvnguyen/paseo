/**
 * @vitest-environment jsdom
 */
/**
 * The provider settings sheet's model-prefix (model tag) field.
 *
 * What this proves: the preview line reports what the typed text normalizes to,
 * a 25-character tag shows an inline error and cannot be saved, and clearing the
 * field saves "no tag" rather than an empty string. jsdom computes no layout, so
 * this says nothing about pixel bounds — it pins the validate/save contract.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
// @ts-expect-error - provider-model-prefix-field.ts wins extensionless resolution;
// the component lives in the sibling .tsx and must be imported with its extension.
import { ProviderModelPrefixField } from "./provider-model-prefix-field.tsx";

beforeEach(() => {
  vi.stubGlobal("React", React);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

// Load translations so the field renders its real copy.
void testI18n;

// The real editing surface reaches for native modules the jsdom run has no
// answer for. The stub keeps the contract that matters here: it seeds from
// `initialValue` and re-seeds when `resetKey` moves.
vi.mock("@/components/adaptive-modal-sheet", async () => {
  const { createElement, useEffect, useRef } = await import("react");
  return {
    AdaptiveModalSheet: () => null,
    AdaptiveTextInput: ({
      initialValue,
      resetKey,
      onChangeText,
      onSubmitEditing,
      testID,
      accessibilityLabel,
      placeholder,
    }: {
      initialValue?: string;
      resetKey?: string;
      onChangeText?: (value: string) => void;
      onSubmitEditing?: () => void;
      testID?: string;
      accessibilityLabel?: string;
      placeholder?: string;
    }) => {
      const ref = useRef<HTMLInputElement | null>(null);
      useEffect(() => {
        if (ref.current) ref.current.value = initialValue ?? "";
      }, [resetKey, initialValue]);
      return createElement(
        "form",
        {
          onSubmit: (event: { preventDefault: () => void }) => {
            event.preventDefault();
            onSubmitEditing?.();
          },
        },
        createElement("input", {
          ref,
          defaultValue: initialValue,
          "data-testid": testID,
          "aria-label": accessibilityLabel,
          placeholder,
          onChange: (event: { target: { value: string } }) => onChangeText?.(event.target.value),
        }),
      );
    },
  };
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

interface FieldProps {
  storedPrefix?: string;
  isSaving?: boolean;
  visible?: boolean;
}

interface MountedField {
  container: HTMLDivElement;
  onSave: ReturnType<typeof vi.fn>;
  render: (props?: FieldProps) => void;
}

function mountField(initial: FieldProps): MountedField {
  const onSave = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (props: FieldProps = {}) => {
    const resolved = { ...initial, ...props };
    act(() => {
      root.render(
        <ProviderModelPrefixField
          storedPrefix={resolved.storedPrefix}
          onSave={onSave}
          isSaving={resolved.isSaving ?? false}
          visible={resolved.visible ?? true}
        />,
      );
    });
  };
  render();
  mounted.push({ root, container });
  return { container, onSave, render };
}

function input(container: HTMLDivElement): HTMLInputElement {
  const element = within(container).getByTestId("provider-model-prefix-input");
  if (!(element instanceof HTMLInputElement)) throw new Error("input did not render");
  return element;
}

// React tracks the input's value with its own descriptor, so assigning `.value`
// directly leaves its change tracker thinking nothing happened. Go through the
// native setter so the synthetic onChange actually fires.
function type(container: HTMLDivElement, value: string): void {
  const field = input(container);
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!nativeSetter) throw new Error("no native value setter");
  act(() => {
    nativeSetter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function saveButton(container: HTMLDivElement): HTMLElement {
  return within(container).getByTestId("provider-model-prefix-save");
}

// react-native-web's Pressable renders a div carrying `aria-disabled`, not a
// real <button disabled>, so read whichever the surface exposes.
function isSaveDisabled(container: HTMLDivElement): boolean {
  const element = saveButton(container);
  const ariaDisabled = element.getAttribute("aria-disabled");
  if (ariaDisabled !== null) return ariaDisabled === "true";
  return (element as HTMLButtonElement).disabled === true;
}

function pressSave(container: HTMLDivElement): void {
  act(() => {
    saveButton(container).click();
  });
}

function lineOf(container: HTMLDivElement, suffix: string): string {
  const element = container.querySelector(`[data-testid$="${suffix}"]`);
  return element?.textContent ?? "";
}

describe("ProviderModelPrefixField", () => {
  it("seeds the textbox from the stored tag", () => {
    const { container } = mountField({ storedPrefix: "Go" });

    expect(input(container).value).toBe("Go");
  });

  it("starts empty when no tag is stored", () => {
    const { container } = mountField({});

    expect(input(container).value).toBe("");
  });

  it("previews the bracketed tag and enables saving for a real change", () => {
    const { container } = mountField({ storedPrefix: undefined });

    expect(isSaveDisabled(container)).toBe(true);
    type(container, "Zen");

    expect(lineOf(container, "-hint")).toBe(
      testI18n.t("settings.providers.modelPrefix.preview", { tag: "[Zen]" }),
    );
    expect(isSaveDisabled(container)).toBe(false);
  });

  it("keeps saving disabled while the text still matches the stored tag", () => {
    const { container } = mountField({ storedPrefix: "Go" });

    // Equivalent up to brackets: normalization makes this a no-op edit.
    type(container, "[Go]");

    expect(isSaveDisabled(container)).toBe(true);
  });

  it("saves the normalized value, dropping surrounding whitespace and brackets", () => {
    const { container, onSave } = mountField({ storedPrefix: "Go" });

    type(container, "  [Zen]  ");
    pressSave(container);

    expect(onSave).toHaveBeenCalledWith("Zen");
  });

  it("clears the tag when the field is emptied", () => {
    const { container, onSave } = mountField({ storedPrefix: "Go" });

    type(container, "");
    pressSave(container);

    expect(onSave).toHaveBeenCalledWith(undefined);
  });

  it("reports no tag for an empty field", () => {
    const { container } = mountField({ storedPrefix: "Go" });

    type(container, "");

    expect(lineOf(container, "-hint")).toBe(testI18n.t("settings.providers.modelPrefix.cleared"));
    expect(lineOf(container, "-error")).toBe("");
  });

  it("disables saving while a save is already in flight", () => {
    const { container, onSave } = mountField({ storedPrefix: "Go", isSaving: true });

    type(container, "Zen");

    expect(isSaveDisabled(container)).toBe(true);
    pressSave(container);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows an inline error instead of a preview for an overlong tag", () => {
    const { container } = mountField({ storedPrefix: "Go" });

    type(container, "x".repeat(25));

    expect(lineOf(container, "-error")).toBe(testI18n.t("settings.providers.modelPrefix.invalid"));
    expect(lineOf(container, "-hint")).toBe("");
  });

  it("never saves an overlong tag", () => {
    const { container, onSave } = mountField({ storedPrefix: "Go" });

    type(container, "x".repeat(25));
    pressSave(container);

    expect(onSave).not.toHaveBeenCalled();
    expect(isSaveDisabled(container)).toBe(true);
  });

  it("drops the draft when the sheet closes and reopens", () => {
    const { container, render } = mountField({ storedPrefix: "Go" });

    type(container, "Zen");
    expect(input(container).value).toBe("Zen");

    render({ visible: false });
    render({ visible: true });

    expect(input(container).value).toBe("Go");
  });
});
