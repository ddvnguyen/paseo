import { describe, expect, test } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

import {
  buildProviderModelPrefixes,
  formatProviderModelPrefix,
  normalizeProviderModelPrefix,
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
      ["omp", "Go"],
      ["omp-zen", "Zen"],
    ]);
  });

  test("yields an empty map when nothing is configured", () => {
    expect(buildProviderModelPrefixes(null).size).toBe(0);
    expect(buildProviderModelPrefixes(configWithProviders({})).size).toBe(0);
  });
});
