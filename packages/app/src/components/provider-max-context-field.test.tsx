/**
 * @vitest-environment jsdom
 */
/**
 * The provider settings sheet's max-context field.
 *
 * What this proves: the preview line reports what the typed text actually parses
 * to, garbage shows an inline error and cannot be saved, and clearing the field
 * writes "no limit" rather than a zero. jsdom computes no layout, so this says
 * nothing about pixel bounds — it pins the parse/validate/save contract.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { ProviderMaxContextField } from "./provider-max-context-field";

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

interface MountedField {
  container: HTMLDivElement;
  onSave: ReturnType<typeof vi.fn>;
}

function mountField(storedTokens: number | undefined): MountedField {
  const onSave = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <ProviderMaxContextField
        storedTokens={storedTokens}
        onSave={onSave}
        isSaving={false}
        visible
      />,
    ),
  );
  mounted.push({ root, container });
  return { container, onSave };
}

function input(container: HTMLDivElement): HTMLInputElement {
  const element = within(container).getByTestId("provider-max-context-input");
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
  return within(container).getByTestId("provider-max-context-save");
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

describe("ProviderMaxContextField", () => {
  it("seeds the textbox from the stored cap in its shortest exact form", () => {
    const { container } = mountField(128_000);

    expect(input(container).value).toBe("128 K");
  });

  it("starts empty when no cap is stored", () => {
    const { container } = mountField(undefined);

    expect(input(container).value).toBe("");
  });

  it("previews the parsed token count and enables saving", () => {
    const { container } = mountField(undefined);

    type(container, "100 M");

    expect(lineOf(container, "-hint")).toContain("100,000,000");
    expect(isSaveDisabled(container)).toBe(false);
  });

  it("accepts a bare token count", () => {
    const { container, onSave } = mountField(undefined);

    type(container, "128000");
    pressSave(container);

    expect(onSave).toHaveBeenCalledWith(128_000);
  });

  it("keeps saving disabled while the text still matches the stored cap", () => {
    const { container } = mountField(128_000);

    type(container, "128 K");

    expect(isSaveDisabled(container)).toBe(true);
  });

  it("shows an inline error instead of a preview for unparseable text", () => {
    const { container } = mountField(128_000);

    type(container, "100 MB");

    expect(lineOf(container, "-error")).not.toBe("");
    expect(lineOf(container, "-hint")).toBe("");
  });

  it("never saves an unparseable value", () => {
    const { container, onSave } = mountField(128_000);

    type(container, "nonsense");
    pressSave(container);

    expect(onSave).not.toHaveBeenCalled();
    expect(isSaveDisabled(container)).toBe(true);
  });

  it("treats submitting from the keyboard the same as pressing save", () => {
    const { container, onSave } = mountField(undefined);

    type(container, "1000M");
    act(() => {
      input(container).form?.requestSubmit();
    });

    expect(onSave).toHaveBeenCalledWith(1_000_000_000);
  });

  it("clears the cap when the field is emptied", () => {
    const { container, onSave } = mountField(128_000);

    type(container, "");
    pressSave(container);

    expect(onSave).toHaveBeenCalledWith(undefined);
  });

  it("reports no limit for an empty field", () => {
    const { container } = mountField(128_000);

    type(container, "");

    expect(lineOf(container, "-hint")).toBe(testI18n.t("settings.providers.maxContext.unlimited"));
    expect(lineOf(container, "-error")).toBe("");
  });
});
