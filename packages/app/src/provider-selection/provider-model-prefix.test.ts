import { describe, expect, test } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

import {
  buildProviderModelPrefixes,
  buildSubProviderModelSections,
  collectSubProviderIds,
  formatProviderModelPrefix,
  normalizeProviderModelPrefix,
  readModelSubProviderId,
  resolveModelPrefixTags,
} from "./provider-model-prefix";

function configWithProviders(providers: MutableDaemonConfig["providers"]): MutableDaemonConfig {
  return { providers } as MutableDaemonConfig;
}

describe("normalizeProviderModelPrefix", () => {
  test("keeps a bare token as written", () => {
    expect(normalizeProviderModelPrefix("Go")).toBe("Go");
  });

  test("unwraps a prefix the user already bracketed", () => {
    expect(normalizeProviderModelPrefix("[Zen]")).toBe("Zen");
  });

  test("treats empty and whitespace-only values as no tag", () => {
    expect(normalizeProviderModelPrefix("")).toBeUndefined();
    expect(normalizeProviderModelPrefix("   ")).toBeUndefined();
    expect(normalizeProviderModelPrefix(undefined)).toBeUndefined();
    expect(normalizeProviderModelPrefix("[]")).toBeUndefined();
  });
});

describe("formatProviderModelPrefix", () => {
  test("brackets a tag and renders nothing for an absent one", () => {
    expect(formatProviderModelPrefix("Go")).toBe("[Go]");
    expect(formatProviderModelPrefix(undefined)).toBe("");
  });
});

describe("buildProviderModelPrefixes", () => {
  test("maps configured providers to their bare tag", () => {
    const prefixes = buildProviderModelPrefixes(
      configWithProviders({
        omp: { modelPrefix: "Go" },
        "omp-zen": { modelPrefix: "[Zen]" },
        claude: { enabled: true },
        blank: { modelPrefix: "  " },
      }),
    );

    expect([...prefixes.entries()]).toEqual([
      ["omp", { providerWide: "Go", bySubProvider: new Map() }],
      ["omp-zen", { providerWide: "Zen", bySubProvider: new Map() }],
    ]);
  });

  test("keeps a provider whose only tags are per-sub-provider", () => {
    // A provider can declare sub-provider tags with no provider-wide tag at all;
    // dropping it would leave those rows undecorated and unfixable in the UI.
    const prefixes = buildProviderModelPrefixes(
      configWithProviders({ opencode: { modelPrefixes: { anthropic: "Ant" } } }),
    );

    expect(prefixes.get("opencode")).toEqual({
      providerWide: undefined,
      bySubProvider: new Map([["anthropic", "Ant"]]),
    });
  });

  test("normalizes each per-sub-provider tag the same way as the provider-wide one", () => {
    const prefixes = buildProviderModelPrefixes(
      configWithProviders({
        opencode: { modelPrefix: "[Go]", modelPrefixes: { anthropic: "[Ant]", openai: "  " } },
      }),
    );

    expect(prefixes.get("opencode")).toEqual({
      providerWide: "Go",
      // Blank tags are dropped so they cannot shadow the provider-wide fallback.
      bySubProvider: new Map([["anthropic", "Ant"]]),
    });
  });

  test("yields an empty map when nothing is configured", () => {
    expect(buildProviderModelPrefixes(null).size).toBe(0);
    expect(buildProviderModelPrefixes(configWithProviders({})).size).toBe(0);
  });
});

describe("readModelSubProviderId", () => {
  test("reads the sub-provider an adapter reports", () => {
    expect(
      readModelSubProviderId({
        id: "anthropic/claude-sonnet-4",
        metadata: { providerId: "anthropic" },
      }),
    ).toBe("anthropic");
  });

  test("treats an absent, blank, or non-string value as no sub-provider", () => {
    // `AgentMetadata` is an open record, so `providerId` arrives untyped and a
    // number or object must not become a map key.
    for (const metadata of [
      undefined,
      {},
      { providerId: "" },
      { providerId: "  " },
      { providerId: 7 },
      { providerId: {} },
    ]) {
      expect(
        readModelSubProviderId({ id: "claude-sonnet-4", metadata }),
        JSON.stringify(metadata),
      ).toBeUndefined();
    }
  });

  test("does not guess a sub-provider from the model id", () => {
    // The id's leading segment is a sub-provider only for the adapters that set
    // `providerId`. Inferring it here would tag models from other providers wrong.
    expect(readModelSubProviderId({ id: "anthropic/claude-sonnet-4" })).toBeUndefined();
  });
});

describe("resolveModelPrefixTags", () => {
  const anthropicModel = { id: "anthropic/claude-sonnet-4", metadata: { providerId: "anthropic" } };
  const openaiModel = { id: "openai/gpt-5.4", metadata: { providerId: "openai" } };
  const tags = {
    providerWide: "Go",
    bySubProvider: new Map([["anthropic", "Ant"]]),
  };

  test("prefers the model's own sub-provider tag", () => {
    expect(resolveModelPrefixTags(tags, anthropicModel)).toBe("Ant");
  });

  test("falls back to the provider-wide tag for a sub-provider with no entry", () => {
    expect(resolveModelPrefixTags(tags, openaiModel)).toBe("Go");
  });

  test("falls back to the provider-wide tag for a model with no sub-provider", () => {
    expect(resolveModelPrefixTags(tags, { id: "claude-sonnet-4" })).toBe("Go");
  });

  test("leaves the row undecorated when the sub-provider tag is the only one and it misses", () => {
    expect(
      resolveModelPrefixTags(
        { providerWide: undefined, bySubProvider: new Map([["anthropic", "Ant"]]) },
        openaiModel,
      ),
    ).toBeUndefined();
  });

  test("resolves to undefined for a provider that declares no tags at all", () => {
    expect(resolveModelPrefixTags(undefined, anthropicModel)).toBeUndefined();
  });
});

describe("collectSubProviderIds", () => {
  const model = (id: string, providerId?: unknown) => ({
    id,
    ...(providerId === undefined ? {} : { metadata: { providerId } }),
  });

  test("lists each sub-provider once, sorted", () => {
    // One tag section renders per entry, so a duplicate would render two fields
    // editing the same key and the order must not churn between refreshes.
    expect(
      collectSubProviderIds([
        model("openai/gpt-5.4", "openai"),
        model("anthropic/claude-sonnet-4", "anthropic"),
        model("openai/gpt-5.4-mini", "openai"),
      ]),
    ).toEqual(["anthropic", "openai"]);
  });

  test("is empty for a provider whose models declare no sub-provider", () => {
    // The non-aggregating providers must render exactly what they render today.
    expect(collectSubProviderIds([model("claude-sonnet-4"), model("claude-opus-4")])).toEqual([]);
  });

  test("ignores blank and non-string sub-provider ids rather than listing them", () => {
    expect(
      collectSubProviderIds([
        model("a/1", ""),
        model("b/1", "  "),
        model("c/1", 7),
        model("d/1", "anthropic"),
      ]),
    ).toEqual(["anthropic"]);
  });

  test("keeps ids that are not plain slugs", () => {
    expect(collectSubProviderIds([model("wafer.ai/1", "wafer.ai")])).toEqual(["wafer.ai"]);
  });

  test("handles an empty catalog", () => {
    expect(collectSubProviderIds([])).toEqual([]);
  });
});

describe("buildSubProviderModelSections", () => {
  const model = (id: string, providerId?: unknown) => ({
    id,
    ...(providerId === undefined ? {} : { metadata: { providerId } }),
  });

  const ANTHROPIC = model("anthropic/claude-sonnet-4", "anthropic");
  const OPENAI = model("openai/gpt-5.4", "openai");
  const OPENAI_MINI = model("openai/gpt-5.4-mini", "openai");

  test("puts each sub-provider's rows under its own section", () => {
    expect(
      buildSubProviderModelSections(["anthropic", "openai"], [ANTHROPIC, OPENAI, OPENAI_MINI]),
    ).toEqual([
      { subProviderId: "anthropic", models: [ANTHROPIC] },
      { subProviderId: "openai", models: [OPENAI, OPENAI_MINI] },
    ]);
  });

  test("keeps the caller's section order rather than re-sorting it", () => {
    // The order is collectSubProviderIds' to choose; re-sorting here would make
    // the sheet's field order disagree with the list the sheet derives it from.
    expect(
      buildSubProviderModelSections(["openai", "anthropic"], [ANTHROPIC, OPENAI]).map(
        (section) => section.subProviderId,
      ),
    ).toEqual(["openai", "anthropic"]);
  });

  test("gives a section no rows when every one of them was filtered out", () => {
    // The tag field must survive a search: it is the only way to edit the tag
    // for a sub-provider whose rows are not currently visible.
    expect(buildSubProviderModelSections(["anthropic", "openai"], [OPENAI])).toEqual([
      { subProviderId: "anthropic", models: [] },
      { subProviderId: "openai", models: [OPENAI] },
    ]);
  });

  test("renders one remainder section last for models that declare no sub-provider", () => {
    const loose = model("claude-sonnet-4");
    expect(buildSubProviderModelSections(["anthropic"], [loose, ANTHROPIC])).toEqual([
      { subProviderId: "anthropic", models: [ANTHROPIC] },
      { subProviderId: undefined, models: [loose] },
    ]);
  });

  test("omits the remainder section when every model declares a sub-provider", () => {
    // An empty leftover section reads as one that failed to load.
    expect(
      buildSubProviderModelSections(["anthropic", "openai"], [ANTHROPIC, OPENAI]),
    ).toHaveLength(2);
  });

  test("renders a sub-provider section for rows the section list never mentioned", () => {
    // Search can leave a sub-provider that collectSubProviderIds did not list —
    // e.g. the caller passed a stale list. Dropping its rows would strand them in
    // a bucket with no header, which is the failure mode grouping exists to avoid.
    const sections = buildSubProviderModelSections(["anthropic"], [OPENAI]);

    expect(sections).toEqual([
      { subProviderId: "anthropic", models: [] },
      { subProviderId: "openai", models: [OPENAI] },
    ]);
  });

  test("appends an unlisted sub-provider after the listed ones, sorted", () => {
    const sections = buildSubProviderModelSections(
      ["openai"],
      [ANTHROPIC, model("z/1", "z"), OPENAI],
    );

    expect(sections.map((section) => section.subProviderId)).toEqual(["openai", "anthropic", "z"]);
  });

  test("leaves a provider with no sub-providers a single remainder section", () => {
    // The non-aggregating providers must render exactly what they render today:
    // one list, under the header they already use.
    const loose = [model("claude-sonnet-4"), model("claude-opus-4")];

    expect(buildSubProviderModelSections([], loose)).toEqual([
      { subProviderId: undefined, models: loose },
    ]);
  });

  test("returns nothing for a search that matched no model", () => {
    expect(buildSubProviderModelSections(["anthropic", "openai"], [])).toEqual([
      { subProviderId: "anthropic", models: [] },
      { subProviderId: "openai", models: [] },
    ]);
  });

  test("keys a group by exactly what collectSubProviderIds enumerated", () => {
    // The two functions feed the same render. If they disagreed about what counts
    // as a sub-provider, rows would land under a header that does not exist, so
    // pin them to each other rather than to a hand-written list.
    const served = [
      model("a/1", " anthropic "),
      model("b/1", ""),
      model("c/1", 7),
      model("d/1"),
      model("wafer.ai/1", "wafer.ai"),
    ];

    const sections = buildSubProviderModelSections(collectSubProviderIds(served), served);
    const groups = sections.filter((section) => section.subProviderId !== undefined);

    expect(groups.map((section) => section.subProviderId)).toEqual(collectSubProviderIds(served));
    // Every served model lands in exactly one section — none dropped, none listed
    // twice. Grouping deliberately reorders rows into section order, so compare
    // membership rather than the flat sequence.
    expect(
      sections
        .flatMap((section) => section.models)
        .map((row) => row.id)
        .sort(),
    ).toEqual(served.map((row) => row.id).sort());
  });
});
