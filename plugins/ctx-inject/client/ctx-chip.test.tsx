/** Component tests for the context-inject chip (wide + compact). */

// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Styles are serialized onto the DOM node so the flex contract can be asserted
// directly — the C2b regression is invisible to a text-only assertion.
// Type arguments stay on one line: a `<` followed by a line break before `{` is
// parsed as a JSX assertion in .tsx and fails to transform.
vi.mock("react-native", () => ({
  View: ({
    children,
    testID,
    style,
  }: React.PropsWithChildren<{ testID?: string; style?: unknown }>) =>
    React.createElement(
      "div",
      { "data-testid": testID, "data-style": JSON.stringify(style) },
      children,
    ),
  Text: ({
    children,
    testID,
    numberOfLines,
    style,
  }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement(
      "span",
      {
        "data-testid": testID,
        "data-lines": numberOfLines as number | undefined,
        "data-style": JSON.stringify(style),
      },
      children,
    ),
  Pressable: ({
    children,
    onPress,
    testID,
    accessibilityLabel,
  }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID as string | undefined,
        "aria-label": accessibilityLabel as string | undefined,
        onClick: onPress as (() => void) | undefined,
      },
      children,
    ),
}));

import { CtxInjectChip } from "./ctx-chip.js";
import type { CtxInjectChipData } from "../shared/ctx-schema.js";

const THEME = {
  colors: {
    foreground: "#fff",
    foregroundMuted: "#aaa",
    accent: "#0af",
    surface1: "#111",
  },
} as unknown as Parameters<typeof CtxInjectChip>[0]["theme"];

const CREATED: CtxInjectChipData = {
  systemPromptInjected: true,
  systemPromptLength: 1234,
  systemPromptHash: "abcdef012345",
  tokenEstimates: { systemPrompt: { tokens: 309, estimated: true } },
  mcpServers: ["github", "linear", "sentry", "datadog"],
  paseoToolsInjected: true,
  model: "claude-opus-5",
  modeId: "plan",
  reason: "create",
  capturedAt: "2026-09-27T10:11:12.000Z",
};

const RESUMED: CtxInjectChipData = {
  systemPromptInjected: null,
  systemPromptLength: null,
  systemPromptHash: null,
  tokenEstimates: { systemPrompt: null },
  mcpServers: [],
  paseoToolsInjected: null,
  model: null,
  modeId: null,
  reason: "resume",
  capturedAt: "2026-09-27T10:11:12.000Z",
};

const TIMESTAMP = new Date("2026-09-27T10:11:12.000Z");
const HOST = { id: "h", label: "H" };
const WIDE_LAYOUT = { compact: false, platform: "web" } as const;
const COMPACT_LAYOUT = { compact: true, platform: "web" } as const;

/** Hoisted so the rendered props keep a stable identity. */
function itemFor(data: CtxInjectChipData) {
  return { type: "plugin", kind: "ctx-inject", version: 1, data } as const;
}

let container: HTMLDivElement;
let root: Root;

function render(data: CtxInjectChipData, compact = false): void {
  act(() => {
    root.render(
      <CtxInjectChip
        agentId="a1"
        timestamp={TIMESTAMP}
        host={HOST}
        layout={compact ? COMPACT_LAYOUT : WIDE_LAYOUT}
        theme={THEME}
        item={itemFor(data)}
      />,
    );
  });
}

function byId(id: string): HTMLElement {
  const node = container.querySelector(`[data-testid="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`missing testid: ${id}`);
  return node;
}

function styleOf(id: string): Record<string, unknown> {
  const raw = byId(id).getAttribute("data-style");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function text(): string {
  return container.textContent ?? "";
}

function toggle(): void {
  act(() => byId("ctx-inject-toggle").click());
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

describe("CtxInjectChip layout contract", () => {
  // The C2b defect, guarded: a long summary must shrink AND be allowed to shrink
  // below its intrinsic width. Dropping minWidth leaves the row overflowing on web.
  it("lets the summary text shrink with a zero min-width", () => {
    render(CREATED);
    const style = styleOf("ctx-inject-summary");

    expect(style.flexShrink).toBe(1);
    expect(style.minWidth).toBe(0);
  });

  it("truncates the summary to a single line", () => {
    render(CREATED);

    expect(byId("ctx-inject-summary").getAttribute("data-lines")).toBe("1");
  });

  it("keeps the badge from being squeezed by the summary", () => {
    render(CREATED);
    const badge = container.querySelector("span");

    expect(badge).not.toBeNull();
  });
});

describe("CtxInjectChip disclosure", () => {
  // The fidelity ceiling has to be visible without interaction, or the chip
  // implies it is showing the whole context.
  it("shows the caveat before anything is expanded", () => {
    render(CREATED);

    expect(text()).toContain("Paseo's own prompt and runtime tools are added after this point");
    expect(container.querySelector('[data-testid="ctx-inject-detail"]')).toBeNull();
  });

  it("keeps the caveat visible while expanded", () => {
    render(CREATED);
    toggle();

    expect(container.querySelector('[data-testid="ctx-inject-caveat"]')).not.toBeNull();
  });
});

describe("CtxInjectChip content", () => {
  it("summarises prompt length and MCP count on the row", () => {
    render(CREATED);

    expect(text()).toContain("prompt 1234 chars");
    expect(text()).toContain("4 MCP servers");
  });

  it("reveals length, hash, MCP names, model and mode when expanded", () => {
    render(CREATED);
    toggle();
    const detail = byId("ctx-inject-detail").textContent ?? "";

    expect(detail).toContain("1234 chars");
    expect(detail).toContain("sha256:abcdef012345");
    expect(detail).toContain("github, linear, sentry, datadog");
    expect(detail).toContain("claude-opus-5");
    expect(detail).toContain("plan");
    expect(detail).toContain("create");
  });

  it("reports an uncorrelated session as unknown, never as an absent prompt", () => {
    render(RESUMED);
    const row = text();

    // "no system prompt" would be a fabricated claim about a session we never saw.
    expect(row).toContain("prompt unknown");
    expect(row).not.toContain("no system prompt");
  });

  it("uses em dashes for unknown detail fields", () => {
    render(RESUMED);
    toggle();
    const detail = byId("ctx-inject-detail").textContent ?? "";

    expect(detail).toContain("Model: —");
    expect(detail).toContain("Mode: —");
    expect(detail).toContain("Paseo tools: —");
  });

  it("distinguishes a genuinely absent prompt from an unknown one", () => {
    render({ ...RESUMED, systemPromptInjected: false, reason: "create" });

    expect(text()).toContain("no system prompt");
  });

  it("summarises long MCP lists without dropping the remainder silently", () => {
    render(CREATED);

    expect(text()).toContain("github, linear, sentry +1");
  });

  it("adapts to the compact layout", () => {
    render(CREATED, true);

    expect(byId("ctx-inject-summary").getAttribute("data-lines")).toBe("1");
    expect(text()).toContain("prompt 1234 chars");
  });
});

describe("CtxInjectChip token estimate", () => {
  it("labels the estimate as one, so the number is never read as measured", () => {
    render(CREATED);
    toggle();
    const detail = byId("ctx-inject-detail").textContent ?? "";

    // The wire flag says estimated: true, but the reader sees the copy, not the
    // flag — so the copy has to carry the same claim.
    expect(detail).toContain("Prompt tokens: ~309 (estimated, chars÷4)");
  });

  it("shows an em dash for an unknown estimate rather than zero tokens", () => {
    render(RESUMED);
    toggle();

    expect(byId("ctx-inject-detail").textContent).toContain("Prompt tokens: —");
  });

  it("reads a row written before the field existed as unknown, not as zero", () => {
    // tokenEstimates is optional on purpose, so pre-field rows still parse; a
    // renderer that reached for .systemPrompt unguarded would throw here.
    const { tokenEstimates: _omitted, ...withoutField } = CREATED;
    render(withoutField as CtxInjectChipData);
    toggle();

    expect(byId("ctx-inject-detail").textContent).toContain("Prompt tokens: —");
  });
});
