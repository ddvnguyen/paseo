/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import {
  ToolCallSheetProvider,
  useToolCallSheet,
  type ToolCallSheetData,
} from "@/components/tool-call-sheet";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock("lucide-react-native", () => ({ X: () => null }));

vi.mock("@gorhom/bottom-sheet", () => ({
  BottomSheetScrollView: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  BottomSheetBackdrop: () => null,
}));

vi.mock("@/components/ui/isolated-bottom-sheet-modal", () => ({
  IsolatedBottomSheetModal: ({
    children,
    onDismiss,
  }: {
    children: React.ReactNode;
    onDismiss?: () => void;
  }) =>
    React.createElement(
      "div",
      null,
      children,
      React.createElement("button", {
        type: "button",
        "data-testid": "dismiss",
        onClick: onDismiss,
      }),
    ),
  useIsolatedBottomSheetVisibility: () => ({
    sheetRef: { current: null },
    handleSheetChange: () => undefined,
    handleSheetDismiss: () => undefined,
  }),
}));

// The sheet content renders the detail; a text probe is enough to see what it holds.
vi.mock("@/components/tool-call-details", () => ({
  ToolCallDetailsContent: ({ detail }: { detail?: ToolCallDetail }) =>
    React.createElement(
      "span",
      { "data-testid": "sheet-detail" },
      detail && detail.type === "unknown" ? String(detail.input) : "",
    ),
}));

function makeData(text: string): ToolCallSheetData {
  return {
    toolName: "thinking",
    displayName: "Thinking",
    detail: { type: "unknown", input: text, output: null },
    icon: (() => null) as unknown as ToolCallSheetData["icon"],
  };
}

let sheet: ReturnType<typeof useToolCallSheet>;
function Capture() {
  sheet = useToolCallSheet();
  return null;
}

function mountSheet() {
  render(
    <ToolCallSheetProvider>
      <Capture />
    </ToolCallSheetProvider>,
  );
}

const shownDetail = () => screen.queryByTestId("sheet-detail")?.textContent;

afterEach(cleanup);

describe("ToolCallSheetProvider", () => {
  it("shows newer data pushed by the row that opened the sheet", () => {
    mountSheet();
    const row = {};

    act(() => sheet.openToolCall(makeData("thinking so far"), row));
    expect(shownDetail()).toBe("thinking so far");

    act(() => sheet.updateToolCall(row, makeData("thinking so far, and more")));
    expect(shownDetail()).toBe("thinking so far, and more");
  });

  it("ignores updates from a row that did not open the sheet", () => {
    mountSheet();
    const opener = {};
    const otherRow = {};

    act(() => sheet.openToolCall(makeData("opened"), opener));
    act(() => sheet.updateToolCall(otherRow, makeData("from another row")));

    expect(shownDetail()).toBe("opened");
  });

  it("does not revive the sheet from a late update after it is dismissed", () => {
    mountSheet();
    const row = {};

    act(() => sheet.openToolCall(makeData("opened"), row));
    act(() => screen.getByTestId("dismiss").click());
    act(() => sheet.updateToolCall(row, makeData("late update")));

    expect(shownDetail()).toBeUndefined();
  });

  it("does not update a sheet opened without an owner", () => {
    mountSheet();

    act(() => sheet.openToolCall(makeData("opened")));
    act(() => sheet.updateToolCall({}, makeData("stray update")));

    expect(shownDetail()).toBe("opened");
  });
});
