import { describe, expect, it } from "vitest";

import {
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

  it("reads a bare integer as a token count", () => {
    expect(parseMaxContextTokens("128000")).toEqual({ status: "valid", tokens: 128_000 });
    expect(parseMaxContextTokens("1")).toEqual({ status: "valid", tokens: 1 });
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
    for (const text of ["abc", "100 MB", "1.5 M", "-5 M", "1e6", "100 M extra", "1 G"]) {
      expect(parseMaxContextTokens(text), text).toEqual({ status: "invalid" });
    }
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

  it("does not produce a fractional suffix, which the parser rejects", () => {
    expect(formatMaxContextTokens(2_500)).toBe("2500");
  });

  it("falls back to a bare count when neither suffix is exact", () => {
    expect(formatMaxContextTokens(131_072)).toBe("131072");
    expect(formatMaxContextTokens(7)).toBe("7");
  });

  it("round-trips through the parser for every exact branch", () => {
    for (const tokens of [1, 7, 1_000, 128_000, 1_000_000, 100_000_000, 131_072]) {
      expect(parseMaxContextTokens(formatMaxContextTokens(tokens))).toEqual({
        status: "valid",
        tokens,
      });
    }
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
    expect(resolveMaxContextFieldState("128000", 128_000)).toEqual({
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
