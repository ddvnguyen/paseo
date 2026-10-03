import { describe, expect, test } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

import { resolveConfiguredContextCap, resolveContextWindowValues } from "./context-window";

function configWithProviders(providers: MutableDaemonConfig["providers"]): MutableDaemonConfig {
  return { providers } as MutableDaemonConfig;
}

/** The resolved pair for numeric input, narrowed past the unknown branch. */
function resolveCapped(rawMax: number, rawUsed: number, cap: number) {
  const { contextWindowMaxTokens, contextWindowUsedTokens } = resolveContextWindowValues(
    rawMax,
    rawUsed,
    cap,
  );
  if (contextWindowMaxTokens === null || contextWindowUsedTokens === null) {
    throw new Error(`expected a resolved pair for rawMax=${rawMax} rawUsed=${rawUsed} cap=${cap}`);
  }
  return { max: contextWindowMaxTokens, used: contextWindowUsedTokens };
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

  test("pins the displayed usage to the cap when the harness reports past it", () => {
    // The 113% report. A harness counting 56.4 K against a 50 K cap is
    // describing a window the user already ruled out. Holding the raw 56.4 K
    // against the capped 50 K prints a label at
    // 56400 / 50000 = 112.8% -> 113% while the ring, clamped at 100%, already
    // sits full: the two halves of one meter disagreeing. Resolving usage to
    // the cap gives 50000 / 50000 = 100% and both halves read the same.
    expect(resolveContextWindowValues(200_000, 56_400, 50_000)).toEqual({
      contextWindowMaxTokens: 50_000,
      contextWindowUsedTokens: 50_000,
    });
  });

  test("keeps the implied percentage at or under 100% across the capped range", () => {
    // The invariant the printed label leans on: used / max never exceeds 1, so
    // the rounded percentage can never read above 100.
    for (const rawUsed of [0, 25_000, 49_999, 50_000, 50_001, 56_400, 500_000]) {
      const { max, used } = resolveCapped(200_000, rawUsed, 50_000);
      expect(used, `used ${rawUsed}`).toBeLessThanOrEqual(max);
      expect(Math.round((used / max) * 100), `used ${rawUsed}`).toBeLessThanOrEqual(100);
    }
  });

  test("leaves usage below the displayed maximum untouched", () => {
    expect(resolveContextWindowValues(200_000, 49_999, 50_000)).toEqual({
      contextWindowMaxTokens: 50_000,
      contextWindowUsedTokens: 49_999,
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

  test("passes usage above the runtime maximum through when no cap is declared", () => {
    // The regression guard for the uncapped path: a harness reporting more than
    // the window it reported keeps reporting it verbatim. Only a cap may pin
    // the meter, and this pair is what shipped before the numerator clamp.
    expect(resolveContextWindowValues(50_000, 56_400)).toEqual({
      contextWindowMaxTokens: 50_000,
      contextWindowUsedTokens: 56_400,
    });
    expect(resolveContextWindowValues(50_000, 56_400, null)).toEqual({
      contextWindowMaxTokens: 50_000,
      contextWindowUsedTokens: 56_400,
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

  test("leaves usage alone when the displayed maximum cannot be divided by", () => {
    // There is no ratio to clamp against, so the usage count stays a real
    // number. Clamping against a NaN or zero maximum would turn it into NaN and
    // hand the meter a worse version of the unknown it already draws.
    expect(resolveContextWindowValues(Number.NaN, 56_400, 50_000)).toEqual({
      contextWindowMaxTokens: Number.NaN,
      contextWindowUsedTokens: 56_400,
    });
    expect(resolveContextWindowValues(0, 56_400, 50_000)).toEqual({
      contextWindowMaxTokens: 0,
      contextWindowUsedTokens: 56_400,
    });
    expect(resolveContextWindowValues(-1, 56_400, 50_000)).toEqual({
      contextWindowMaxTokens: -1,
      contextWindowUsedTokens: 56_400,
    });
  });
});
