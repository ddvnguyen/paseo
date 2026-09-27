/**
 * @vitest-environment jsdom
 */
/**
 * Layout contract for the provider diagnostic sheet's model rows.
 *
 * QC round 6 found the model-disable switch pushed past the right edge — fully off-screen at
 * 390px, reachable only by scripted click. A long model id used to claim its full intrinsic
 * width, collapsing the row filler and shoving the trailing slot out of the row.
 *
 * What this can and cannot prove: jsdom computes no layout, so there are no real bounding rects
 * to assert and this test deliberately does not pretend otherwise. It pins the flexbox
 * *contract* that produces the correct layout — the id and label must be shrinkable with a zero
 * min-width, and the trailing switch slot must not be. Reintroduce `flexShrink: 0` on the id and
 * this fails. Pixel bounds at each breakpoint are QC's r7 check in a real browser.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import type { ProviderProfileModel } from "@getpaseo/protocol/provider-config";
import { i18n as testI18n } from "@/i18n/i18next";
import { CustomModelRow, DiscoveredModelRow } from "./provider-diagnostic-sheet";

// App sources compile against the classic JSX runtime, which expects React on the global, and
// react-dom only treats act() as supported when this flag is set.
beforeEach(() => {
  vi.stubGlobal("React", React);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

// Load translations so the switch exposes its real accessible name.
void testI18n;

// The sheet module pulls the whole diagnostics surface. Only the row is under test, so the
// host-bound and native-bound leaves are stubbed rather than booted.
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ request: vi.fn(async () => undefined) }),
}));
vi.mock("@/runtime/host-features", () => ({}));
vi.mock("@/hooks/use-providers-snapshot", () => ({ useProvidersSnapshot: () => undefined }));
vi.mock("@/hooks/use-daemon-config", () => ({ useDaemonConfig: () => ({}) }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: () => null,
  AdaptiveTextInput: () => null,
}));

// The real Switch drives reanimated `interpolateColor` off withUnistyles theme colors, and the
// unistyles test stub drops that theme function — so the real track gets `undefined` colors.
// The switch's own box is not what this test measures; the trailing slot that wraps it is.
vi.mock("@/components/ui/switch", async () => {
  const { createElement } = await import("react");
  return {
    Switch: ({ value, accessibilityLabel }: { value: boolean; accessibilityLabel?: string }) =>
      createElement("div", {
        role: "switch",
        "aria-checked": value,
        "aria-label": accessibilityLabel,
      }),
  };
});

const SERVER = "host-a";
const PROVIDER = "claude";
const LABEL = "MiMo V2 Flash";
// A realistic long runtime id — the shape that overflowed.
const LONG_ID = "moonshotai/MiMo-V2-Flash-0321-128k-reasoning-preview-2026-04-01";
const SHORT_ID = "sonnet";
const CATALOG = [LONG_ID, "short-model"];

// Hoisted so the rows get stable prop identities.
const LONG_MODEL: AgentModelDefinition = {
  id: LONG_ID,
  label: LABEL,
  description: "",
  provider: "claude",
};
const SHORT_MODEL: AgentModelDefinition = {
  id: SHORT_ID,
  label: LABEL,
  description: "",
  provider: "claude",
};
const CUSTOM_MODEL: ProviderProfileModel = { id: LONG_ID, label: LABEL };

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mountRow(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

function renderDiscoveredRow(model: AgentModelDefinition) {
  return mountRow(
    <DiscoveredModelRow model={model} serverId={SERVER} provider={PROVIDER} catalogIds={CATALOG} />,
  );
}

function rowOf(container: HTMLDivElement): HTMLElement {
  const row = container.firstElementChild;
  if (!(row instanceof HTMLElement)) throw new Error("model row did not render");
  return row;
}

function textIn(container: HTMLDivElement, text: string): HTMLElement {
  const node = within(rowOf(container)).getByText(text);
  if (!(node instanceof HTMLElement)) throw new Error(`text not rendered: ${text}`);
  return node;
}

function switchIn(container: HTMLDivElement): HTMLElement {
  const toggle = within(rowOf(container)).getByRole("switch");
  if (!(toggle instanceof HTMLElement)) throw new Error("model switch did not render");
  return toggle;
}

/** The trailing slot that wraps the switch. */
function toggleSlotIn(container: HTMLDivElement): HTMLElement {
  const slot = switchIn(container).parentElement;
  if (!(slot instanceof HTMLElement)) throw new Error("toggle slot did not render");
  return slot;
}

describe("provider diagnostic model row layout contract", () => {
  it("lets a long model id shrink instead of pushing the switch out of the row", () => {
    const container = renderDiscoveredRow(LONG_MODEL);
    const idStyle = getComputedStyle(textIn(container, LONG_ID));

    // flexShrink alone is not enough: a CSS flex item defaults to min-width: auto, which pins
    // the id to its intrinsic width and keeps the switch off-screen. Both properties, together.
    expect(idStyle.flexShrink).toBe("1");
    expect(idStyle.minWidth).toBe("0px");
  });

  it("lets a long model label shrink too", () => {
    const container = renderDiscoveredRow(LONG_MODEL);
    const labelStyle = getComputedStyle(textIn(container, LABEL));

    expect(labelStyle.flexShrink).toBe("1");
    expect(labelStyle.minWidth).toBe("0px");
  });

  it("holds the trailing switch slot on the rail by refusing to shrink it", () => {
    const container = renderDiscoveredRow(LONG_MODEL);
    const slotStyle = getComputedStyle(toggleSlotIn(container));

    // This is the invariant that keeps the switch tappable: when the id is squeezed, the switch
    // is not what gives way.
    expect(slotStyle.flexShrink).toBe("0");
  });

  it("bounds the trailing slot so the last-model hint cannot push the delete button off-row", () => {
    const container = renderDiscoveredRow(LONG_MODEL);
    const slotStyle = getComputedStyle(toggleSlotIn(container));

    expect(slotStyle.maxWidth).not.toBe("none");
  });

  it("keeps the switch as the last slot in the row", () => {
    const container = renderDiscoveredRow(LONG_MODEL);
    const row = rowOf(container);

    expect(row.lastElementChild).toBe(toggleSlotIn(container));
  });

  it("leaves an ordinary short-id row on the same contract", () => {
    // The fix must not be a special case for long ids: a normal row still renders the switch as
    // its trailing slot and still lets the id shrink.
    const container = renderDiscoveredRow(SHORT_MODEL);
    const row = rowOf(container);
    const idStyle = getComputedStyle(textIn(container, SHORT_ID));

    expect(idStyle.flexShrink).toBe("1");
    expect(idStyle.minWidth).toBe("0px");
    expect(row.lastElementChild).toBe(toggleSlotIn(container));
  });

  it("applies the same contract to a custom model row with a delete button", () => {
    const container = mountRow(
      <CustomModelRow
        model={CUSTOM_MODEL}
        serverId={SERVER}
        provider={PROVIDER}
        catalogIds={CATALOG}
        deleting={false}
        onDelete={vi.fn()}
      />,
    );
    const row = rowOf(container);
    const idStyle = getComputedStyle(textIn(container, LONG_ID));

    expect(idStyle.flexShrink).toBe("1");
    expect(idStyle.minWidth).toBe("0px");
    // The delete button trails the switch, so the switch is not last in this row shape.
    expect(row.lastElementChild).not.toBe(toggleSlotIn(container));
  });
});
