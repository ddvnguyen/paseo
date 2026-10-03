import { describe, expect, test } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

import { resolveConfiguredContextCap, resolveContextWindowValues } from "./context-window";

function configWithProviders(providers: MutableDaemonConfig["providers"]): MutableDaemonConfig {
  return { providers } as MutableDaemonConfig;
}

describe("resolveConfiguredContextCap", () => {
  test("reads the ceiling the config declares for the provider", () => {
    const config = configWithProviders({ omp: { maxContextTokens: 128_000 } });
    expect(resolveConfiguredContextCap(config, "omp")).toBe(128_000);
  });

  test("keys the lookup by provider, never by whichever entry happens to carry a cap", () => {
    const config = configWithProviders({
      omp: { maxContextTokens: 128_000 },
      claude: {},
    });
    expect(resolveConfiguredContextCap(config, "claude")).toBeNull();
    expect(resolveConfiguredContextCap(config, "codex")).toBeNull();
  });

  test("reports no cap for an absent config, provider, or entry", () => {
    const config = configWithProviders({ omp: { maxContextTokens: 128_000 } });
    expect(resolveConfiguredContextCap(null, "omp")).toBeNull();
    expect(resolveConfiguredContextCap(undefined, "omp")).toBeNull();
    expect(resolveConfiguredContextCap(config, null)).toBeNull();
    expect(resolveConfiguredContextCap(configWithProviders({}), "omp")).toBeNull();
  });

  test("refuses a ceiling that would divide the meter by nothing", () => {
    for (const cap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveConfiguredContextCap(configWithProviders({ omp: { maxContextTokens: cap } }), "omp"),
        String(cap),
      ).toBeNull();
    }
  });
});

describe("resolveContextWindowValues", () => {
  test("lowers the displayed maximum to the cap when the harness reports more", () => {
    // The enforcement case. A harness that reports 200 K against a 128 K cap is
    // describing a window the user has already ruled out; drawing 200 K would
    // show a permanently half-full meter and hide the cap entirely.
    expect(resolveContextWindowValues(200_000, 100_000, 128_000)).toEqual({
      contextWindowMaxTokens: 128_000,
      contextWindowUsedTokens: 100_000,
    });
  });

  test("keeps the harness number when it is already under the cap", () => {
    // A cap is a ceiling, not a target. Raising the maximum to the cap would
    // understate how full the window is and could push the meter past 100%.
    expect(resolveContextWindowValues(100_000, 50_000, 128_000)).toEqual({
      contextWindowMaxTokens: 100_000,
      contextWindowUsedTokens: 50_000,
    });
  });

  test("keeps the harness number when it exactly equals the cap", () => {
    expect(resolveContextWindowValues(128_000, 128_000, 128_000)).toEqual({
      contextWindowMaxTokens: 128_000,
      contextWindowUsedTokens: 128_000,
    });
  });

  test("returns the runtime pair unchanged when the provider declares no cap", () => {
    expect(resolveContextWindowValues(200_000, 100_000)).toEqual({
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 100_000,
    });
    expect(resolveContextWindowValues(200_000, 100_000, null)).toEqual({
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 100_000,
    });
  });

  test("leaves the maximum unknown rather than substituting the cap", () => {
    // Nothing has reported a window yet. Announcing the cap here would draw a
    // meter against a harness that never reported one.
    expect(resolveContextWindowValues(null, 100_000, 128_000)).toEqual({
      contextWindowMaxTokens: null,
      contextWindowUsedTokens: null,
    });
    expect(resolveContextWindowValues(200_000, null, 128_000)).toEqual({
      contextWindowMaxTokens: null,
      contextWindowUsedTokens: null,
    });
  });

  test("ignores a cap that is not a usable ceiling", () => {
    for (const cap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveContextWindowValues(200_000, 100_000, cap), String(cap)).toEqual({
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 100_000,
      });
    }
  });

  test("clamps an unbounded harness maximum to a cap", () => {
    // A harness reporting Infinity has no window to enforce against, but the
    // user's cap still is one, so the ceiling wins. A NaN maximum is left
    // alone: the meter already reads it as unknown, and that is what it
    // rendered before this change.
    expect(resolveContextWindowValues(Number.POSITIVE_INFINITY, 100_000, 128_000)).toEqual({
      contextWindowMaxTokens: 128_000,
      contextWindowUsedTokens: 100_000,
    });
  });
});
