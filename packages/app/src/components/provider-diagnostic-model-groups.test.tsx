/**
 * @vitest-environment jsdom
 */
/**
 * Structure contract for the provider sheet's per-sub-provider model groups.
 *
 * The sheet renders one "Model tag · <sub>" field per served sub-provider. Until
 * now the models list beneath them was flat, so the field and the rows it governs
 * were only connected by the user reading both. These tests pin the three things
 * that can silently break that connection:
 *
 *   1. each row renders inside the group of the sub-provider its metadata names;
 *   2. a search narrows the rows without hiding the fields, because a field you
 *      cannot reach is a field you cannot edit;
 *   3. rows that name no sub-provider still render, under one list of their own.
 *
 * Plus the one absence that has to stay absent: the provider-wide tag field,
 * removed 2026-10-03 on the owner's directive. Every tag field belongs to a
 * sub-provider, so a test that only counted fields would not notice it coming
 * back.
 *
 * What this cannot prove: jsdom computes no layout, so "directly beneath" here
 * means document order and containment, not pixels. Visual order and the card
 * seam are QC's check in a real browser.
 */
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { i18n as testI18n } from "@/i18n/i18next";

// App sources compile against the classic JSX runtime, which expects React on the global, and
// react-dom only treats act() as supported when this flag is set.
vi.stubGlobal("React", React);
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Load translations so the real section titles render.
void testI18n;

// The sheet module pulls the whole diagnostics surface. Only its body is under test, so the
// host-bound and native-bound leaves are stubbed rather than booted.
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ request: vi.fn(async () => undefined) }),
}));
vi.mock("@/runtime/host-features", () => ({}));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

const snapshotRef = { current: undefined as ProviderSnapshotEntry[] | undefined };
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: snapshotRef.current,
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    error: null,
    supportsSnapshot: true,
    refresh: vi.fn(async () => undefined),
    refetchIfStale: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: null, isLoading: false, patchConfig: vi.fn() }),
}));

interface SheetSearchProps {
  onChange: (value: string) => void;
  testID?: string;
}

function SheetSearchInput({ search: searchField }: { search: SheetSearchProps }) {
  const handleChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => searchField.onChange(event.target.value),
    [searchField],
  );
  return <input type="text" data-testid={searchField.testID} onChange={handleChange} />;
}

// The real sheet is a modal; only its body is under test. The stub renders the
// header's search field as a real input so the query state these tests drive is
// the same one a keystroke drives, then the body.
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    children,
    header,
  }: {
    children?: React.ReactNode;
    header?: { search?: SheetSearchProps };
  }) => (
    <div>
      {header?.search ? <SheetSearchInput search={header.search} /> : null}
      {children}
    </div>
  ),
  AdaptiveTextInput: ({ testID }: { testID?: string }) =>
    testID ? <input type="text" data-testid={testID} readOnly /> : null,
}));

// The real Switch drives reanimated `interpolateColor` off withUnistyles theme colors, and the
// unistyles test stub drops that theme function — so the real track gets `undefined` colors.
// Nothing here asserts on the switch; it just has to render.
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

import { ProviderDiagnosticSheet } from "@/components/provider-diagnostic-sheet";

const SERVER = "host-a";
const PROVIDER = "opencode";

function servedModel(id: string, label: string, providerId?: string): AgentModelDefinition {
  return {
    provider: PROVIDER,
    id,
    label,
    ...(providerId === undefined ? {} : { metadata: { providerId } }),
  };
}

const ANTHROPIC_SONNET = servedModel("anthropic/claude-sonnet-4", "Sonnet 4", "anthropic");
const OPENAI_GPT = servedModel("openai/gpt-5.4", "GPT 5.4", "openai");
const OPENAI_MINI = servedModel("openai/gpt-5.4-mini", "GPT 5.4 mini", "openai");
const LOOSE_MODEL = servedModel("local-llama", "Local Llama");

afterEach(() => {
  cleanup();
  snapshotRef.current = undefined;
});

/** Renders the sheet over the given served models and returns its container. */
function mountSheet(models: AgentModelDefinition[]): HTMLElement {
  snapshotRef.current = [
    { provider: PROVIDER, status: "ready", enabled: true, models } as ProviderSnapshotEntry,
  ];
  const { container } = render(
    <ProviderDiagnosticSheet provider={PROVIDER} visible onClose={vi.fn()} serverId={SERVER} />,
  );
  return container;
}

/** Types into the sheet's search box, driving the header's own onChange. */
function search(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>(
    "[data-testid='provider-settings-search']",
  );
  if (!input) throw new Error("search input did not render");
  fireEvent.change(input, { target: { value } });
}

function queryAll(container: HTMLElement, selector: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(selector)];
}

/** The model ids of every row the sheet currently lists, in document order. */
function renderedModelIds(container: HTMLElement): string[] {
  return queryAll(container, "[data-testid^='provider-sheet-model-row-']").map((row) =>
    (row.getAttribute("data-testid") ?? "").replace("provider-sheet-model-row-", ""),
  );
}

/** The sub-provider groups that rendered, in document order. */
function renderedGroups(container: HTMLElement): string[] {
  return queryAll(container, "[data-testid^='provider-model-sub-section-']").map((section) =>
    (section.getAttribute("data-testid") ?? "").replace("provider-model-sub-section-", ""),
  );
}

function remainderSection(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-testid='provider-model-remainder-section']");
}

describe("provider sheet model groups", () => {
  it("renders each sub-provider's rows inside that sub-provider's own group", () => {
    const container = mountSheet([ANTHROPIC_SONNET, OPENAI_GPT, OPENAI_MINI]);

    expect(renderedGroups(container)).toEqual(["anthropic", "openai"]);
    const anthropic = container.querySelector(
      '[data-testid="provider-model-sub-section-anthropic"]',
    );
    const openai = container.querySelector('[data-testid="provider-model-sub-section-openai"]');
    expect(anthropic?.textContent).toContain("anthropic/claude-sonnet-4");
    expect(anthropic?.textContent).not.toContain("openai/gpt-5.4");
    expect(openai?.textContent).toContain("openai/gpt-5.4");
    expect(openai?.textContent).not.toContain("anthropic/claude-sonnet-4");
  });

  it("renders no sub-provider groups for a provider whose models name none", () => {
    // The non-aggregating providers must look exactly as they did before grouping.
    const container = mountSheet([LOOSE_MODEL, servedModel("other", "Other")]);

    expect(renderedGroups(container)).toEqual([]);
    expect(renderedModelIds(container)).toEqual(["local-llama", "other"]);
    expect(remainderSection(container)).not.toBeNull();
  });

  it("lists rows that name no sub-provider under one remainder section of their own", () => {
    const container = mountSheet([ANTHROPIC_SONNET, LOOSE_MODEL]);

    const remainder = remainderSection(container);
    expect(remainder?.textContent).toContain("local-llama");
    expect(remainder?.textContent).not.toContain("anthropic/claude-sonnet-4");
  });

  it("omits the remainder section when every served model names a sub-provider", () => {
    // An empty leftover section reads as one that failed to load.
    const container = mountSheet([ANTHROPIC_SONNET, OPENAI_GPT]);

    expect(remainderSection(container)).toBeNull();
  });

  it("keeps every tag field reachable while a search narrows the rows", () => {
    const container = mountSheet([ANTHROPIC_SONNET, OPENAI_GPT, OPENAI_MINI, LOOSE_MODEL]);

    search(container, "gpt");

    expect(renderedModelIds(container)).toEqual(["openai/gpt-5.4", "openai/gpt-5.4-mini"]);
    // Both tag fields stay on screen, including the one whose rows are hidden.
    expect(
      container.querySelector('[data-testid="provider-model-prefix-anthropic"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="provider-model-prefix-openai"]')).not.toBeNull();
  });

  it("shows no rows and no remainder section when the search matches nothing", () => {
    const container = mountSheet([ANTHROPIC_SONNET, LOOSE_MODEL]);

    search(container, "zzz-nothing-matches");

    expect(renderedModelIds(container)).toEqual([]);
    expect(remainderSection(container)).toBeNull();
  });

  it("gives each sub-provider field its own testID", () => {
    // React Native testIDs are document-wide, so a shared one would make every
    // query answer with the first field regardless of the sub-provider asked for.
    const container = mountSheet([ANTHROPIC_SONNET, OPENAI_GPT]);

    expect(
      container.querySelector('[data-testid="provider-model-prefix-anthropic-input"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="provider-model-prefix-openai-input"]'),
    ).not.toBeNull();
  });

  it("offers no provider-wide tag field — every tag field belongs to a sub-provider", () => {
    // Owner directive 2026-10-03. The removed field was the one rendered with
    // NO idSuffix, which is exactly what made its testIDs unsuffixed — so their
    // absence is the removal, in any of the field's states. A provider-wide
    // `modelPrefix` already in the config keeps decorating rows that fall back to
    // it; this only removes the editor.
    const container = mountSheet([ANTHROPIC_SONNET, OPENAI_GPT, LOOSE_MODEL]);

    const unsuffixedFields = queryAll(container, "[data-testid^='provider-model-prefix']").filter(
      (field) =>
        /^provider-model-prefix(-(input|save))?$/.test(field.getAttribute("data-testid") ?? ""),
    );
    expect(unsuffixedFields).toEqual([]);

    // The owner-visible half of the same removal: a header reading exactly
    // "Model tag". The per-sub-provider headers read "Model tag · <sub>".
    const bareModelTagHeaders = [...container.querySelectorAll("*")].filter(
      (element) => element.childElementCount === 0 && element.textContent === "Model tag",
    );
    expect(bareModelTagHeaders).toEqual([]);

    // Both sub-provider fields are still there and still editable.
    expect(renderedGroups(container)).toEqual(["anthropic", "openai"]);
    expect(
      container.querySelector('[data-testid="provider-model-prefix-anthropic-save"]'),
    ).not.toBeNull();
  });
});
