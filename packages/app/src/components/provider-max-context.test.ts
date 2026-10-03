import { describe, expect, it } from "vitest";

import {
  buildProviderMaxContextPatch,
  formatMaxContextTokens,
  parseMaxContextTokens,
  resolveMaxContextFieldState,
} from "./provider-max-context";

describe("parseMaxContextTokens", () => {
  it("reads a suffixed value with a space before the suffix", () => {
    expect(parseMaxContextTokens("100 M")).toEqual({ status: "valid", tokens: 100_000_000 });
  });

  it("reads a suffixed value without a space", () => {
    expect(parseMaxContextTokens("1000M")).toEqual({ status: "valid", tokens: 1_000_000_000 });
  });

  it("treats suffixes case-insensitively", () => {
    expect(parseMaxContextTokens("128k")).toEqual({ status: "valid", tokens: 128_000 });
    expect(parseMaxContextTokens("128K")).toEqual({ status: "valid", tokens: 128_000 });
    expect(parseMaxContextTokens("100 m")).toEqual({ status: "valid", tokens: 100_000_000 });
  });

  it("tolerates surrounding and interior whitespace", () => {
    expect(parseMaxContextTokens("   64 K   ")).toEqual({ status: "valid", tokens: 64_000 });
    expect(parseMaxContextTokens("64\tK")).toEqual({ status: "valid", tokens: 64_000 });
  });

  it("uses decimal multipliers, not binary ones", () => {
    expect(parseMaxContextTokens("1 K")).toEqual({ status: "valid", tokens: 1_000 });
    expect(parseMaxContextTokens("1 M")).toEqual({ status: "valid", tokens: 1_000_000 });
  });

  it("reads a bare integer as a count in K", () => {
    expect(parseMaxContextTokens("280")).toEqual({ status: "valid", tokens: 280_000 });
    expect(parseMaxContextTokens("128")).toEqual({ status: "valid", tokens: 128_000 });
    expect(parseMaxContextTokens("1")).toEqual({ status: "valid", tokens: 1_000 });
  });

  it("reads the placeholder's own example the way the placeholder implies", () => {
    // The field shows "280 K" as its placeholder; typing that number without the
    // unit must land on the same ceiling, or the example lies.
    expect(parseMaxContextTokens("280")).toEqual(parseMaxContextTokens("280 K"));
  });

  it("treats an empty field as no limit rather than invalid", () => {
    expect(parseMaxContextTokens("")).toEqual({ status: "empty" });
    expect(parseMaxContextTokens("   ")).toEqual({ status: "empty" });
  });

  it("rejects zero and other non-positive values", () => {
    expect(parseMaxContextTokens("0")).toEqual({ status: "invalid" });
    expect(parseMaxContextTokens("0 M")).toEqual({ status: "invalid" });
  });

  it("rejects text that is not a plain count", () => {
    for (const text of ["abc", "100 MB", "-5 M", "1e6", "100 M extra", "1 G"]) {
      expect(parseMaxContextTokens(text), text).toEqual({ status: "invalid" });
    }
  });

  it("accepts a fraction only when a unit says what it scales", () => {
    expect(parseMaxContextTokens("1.5 M")).toEqual({ status: "valid", tokens: 1_500_000 });
    expect(parseMaxContextTokens("131.072 K")).toEqual({ status: "valid", tokens: 131_072 });
    expect(parseMaxContextTokens("2.5K")).toEqual({ status: "valid", tokens: 2_500 });

    // A bare fraction has no unit to scale and the bare unit is already K, so
    // accepting one would guess twice over.
    expect(parseMaxContextTokens("1.5")).toEqual({ status: "invalid" });
  });

  it("rejects a fraction too fine to be a whole token", () => {
    expect(parseMaxContextTokens("1.2345 K")).toEqual({ status: "invalid" });
    expect(parseMaxContextTokens("1.0000001 M")).toEqual({ status: "invalid" });
  });

  it("rejects a count too large to be a real context window", () => {
    expect(parseMaxContextTokens("99999999999999 M")).toEqual({ status: "invalid" });
  });
});

describe("formatMaxContextTokens", () => {
  it("renders nothing when no cap is stored", () => {
    expect(formatMaxContextTokens(undefined)).toBe("");
  });

  it("prefers the largest suffix that is exact", () => {
    expect(formatMaxContextTokens(1_000_000_000)).toBe("1000 M");
    expect(formatMaxContextTokens(128_000)).toBe("128 K");
  });

  it("always spells the unit out, because a bare number would read back as K", () => {
    // "1000" would come back as a million, and "1000000" as a billion.
    expect(formatMaxContextTokens(1_000)).toBe("1 K");
    expect(formatMaxContextTokens(280_000)).toBe("280 K");
    expect(formatMaxContextTokens(1_000_000)).toBe("1 M");
  });

  it("keeps a count that is not a whole number of thousands exact with a fraction", () => {
    expect(formatMaxContextTokens(2_500)).toBe("2.5 K");
    expect(formatMaxContextTokens(131_072)).toBe("131.072 K");
    expect(formatMaxContextTokens(32_768)).toBe("32.768 K");
    expect(formatMaxContextTokens(7)).toBe("0.007 K");
  });

  it("round-trips through the parser for every exact branch", () => {
    for (const tokens of [1, 7, 1_000, 2_500, 128_000, 280_000, 131_072, 1_000_000, 100_000_000]) {
      expect(parseMaxContextTokens(formatMaxContextTokens(tokens))).toEqual({
        status: "valid",
        tokens,
      });
    }
  });

  it("round-trips every value a context window could plausibly hold", () => {
    // The formatter may never emit text that re-reads as a different number, so
    // this sweeps the whole small range rather than trusting the examples above.
    const sweep: number[] = [];
    for (let tokens = 1; tokens <= 50_000; tokens += 1) {
      sweep.push(tokens);
    }
    for (let exponent = 0; exponent <= 30; exponent += 1) {
      sweep.push(2 ** exponent);
    }

    const mismatches = sweep
      .map((tokens) => [tokens, parseMaxContextTokens(formatMaxContextTokens(tokens))] as const)
      .filter(([tokens, parsed]) => parsed.status !== "valid" || parsed.tokens !== tokens);

    expect(mismatches.map(([tokens]) => tokens)).toEqual([]);
  });
});

describe("resolveMaxContextFieldState", () => {
  it("previews a valid count and marks it dirty against a different stored value", () => {
    expect(resolveMaxContextFieldState("100 M", undefined)).toEqual({
      previewTokens: 100_000_000,
      isValid: true,
      isDirty: true,
    });
  });

  it("is not dirty when the text still parses to the stored value", () => {
    expect(resolveMaxContextFieldState("128", 128_000)).toEqual({
      previewTokens: 128_000,
      isValid: true,
      isDirty: false,
    });
  });

  it("treats clearing the field as dirty when a cap is stored", () => {
    expect(resolveMaxContextFieldState("", 128_000)).toEqual({
      previewTokens: undefined,
      isValid: true,
      isDirty: true,
    });
  });

  it("is not dirty when an empty field matches no stored cap", () => {
    expect(resolveMaxContextFieldState("", undefined)).toMatchObject({
      isValid: true,
      isDirty: false,
    });
  });

  it("never previews or marks dirty an unparseable value", () => {
    expect(resolveMaxContextFieldState("garbage", 128_000)).toEqual({
      previewTokens: undefined,
      isValid: false,
      isDirty: false,
    });
  });
});

describe("buildProviderMaxContextPatch", () => {
  it("writes the ceiling as a plain number", () => {
    expect(buildProviderMaxContextPatch("omp", 128_000)).toEqual({
      omp: { maxContextTokens: 128_000 },
    });
  });

  it("marks a cleared ceiling with an explicit null, never an absent key", () => {
    const patch = buildProviderMaxContextPatch("omp", undefined);

    expect(patch).toEqual({ omp: { maxContextTokens: null } });
    // An absent key is the merge's "leave it alone" signal and would silently
    // fail to clear, which is the defect this marker exists to fix.
    expect(Object.hasOwn(patch.omp, "maxContextTokens")).toBe(true);
    expect(patch.omp.maxContextTokens).toBeNull();
  });

  it("does not emit an empty provider object", () => {
    expect(Object.keys(buildProviderMaxContextPatch("omp", undefined))).toEqual(["omp"]);
    expect(Object.keys(buildProviderMaxContextPatch("omp", undefined).omp)).toEqual([
      "maxContextTokens",
    ]);
  });
});
