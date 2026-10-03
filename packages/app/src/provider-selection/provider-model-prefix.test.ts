import { describe, expect, test } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

import {
  buildProviderModelPrefixes,
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
