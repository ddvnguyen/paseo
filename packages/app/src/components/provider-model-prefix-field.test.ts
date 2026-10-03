import { describe, expect, it } from "vitest";

import {
  buildProviderModelPrefixPatch,
  buildProviderSubModelPrefixPatch,
  resolveModelPrefixFieldState,
} from "./provider-model-prefix-field";

describe("resolveModelPrefixFieldState", () => {
  it("is not dirty when stored and typed tags differ only in brackets", () => {
    expect(resolveModelPrefixFieldState("Go", "[Go]")).toEqual({
      isDirty: false,
      isValid: true,
      normalized: "Go",
      invalidReason: null,
    });
    expect(resolveModelPrefixFieldState("[Go]", "Go")).toEqual({
      isDirty: false,
      isValid: true,
      normalized: "Go",
      invalidReason: null,
    });
  });

  it("is dirty when the typed tag actually differs from the stored one", () => {
    expect(resolveModelPrefixFieldState("Zen", "Go")).toEqual({
      isDirty: true,
      isValid: true,
      normalized: "Zen",
      invalidReason: null,
    });
  });

  it("treats empty and whitespace-only text as a dirty clear", () => {
    expect(resolveModelPrefixFieldState("", "Go")).toEqual({
      isDirty: true,
      isValid: true,
      normalized: undefined,
      invalidReason: null,
    });
    expect(resolveModelPrefixFieldState("   ", "Go")).toEqual({
      isDirty: true,
      isValid: true,
      normalized: undefined,
      invalidReason: null,
    });
  });

  it("is not dirty when an empty field matches a stored absence", () => {
    expect(resolveModelPrefixFieldState("", undefined)).toEqual({
      isDirty: false,
      isValid: true,
      normalized: undefined,
      invalidReason: null,
    });
  });

  it("rejects text longer than the wire cap", () => {
    expect(resolveModelPrefixFieldState("x".repeat(25), undefined)).toEqual({
      isDirty: false,
      isValid: false,
      normalized: undefined,
      invalidReason: "too-long",
    });
  });

  it("accepts a tag at exactly the wire cap", () => {
    expect(resolveModelPrefixFieldState("x".repeat(24), undefined)).toEqual({
      isDirty: true,
      isValid: true,
      normalized: "x".repeat(24),
      invalidReason: null,
    });
  });

  it("trims surrounding whitespace before validating and saving", () => {
    expect(resolveModelPrefixFieldState("  Go  ", undefined)).toEqual({
      isDirty: true,
      isValid: true,
      normalized: "Go",
      invalidReason: null,
    });
    // Whitespace does not count toward the cap: a padded 24-character tag is
    // still a 24-character tag once saved.
    expect(resolveModelPrefixFieldState(`  ${"x".repeat(24)}  `, undefined)).toEqual({
      isDirty: true,
      isValid: true,
      normalized: "x".repeat(24),
      invalidReason: null,
    });
  });

  it("never marks dirty an overlong value that cannot be saved", () => {
    expect(resolveModelPrefixFieldState("x".repeat(25), "Go")).toMatchObject({
      isDirty: false,
      isValid: false,
    });
  });
});

describe("buildProviderModelPrefixPatch", () => {
  it("writes the tag as a plain string", () => {
    expect(buildProviderModelPrefixPatch("omp", "Go")).toEqual({
      omp: { modelPrefix: "Go" },
    });
  });

  it("marks a cleared tag with an explicit null, never an absent key", () => {
    const patch = buildProviderModelPrefixPatch("omp", undefined);

    expect(patch).toEqual({ omp: { modelPrefix: null } });
    // An absent key is the merge's "leave it alone" signal and would silently
    // fail to clear, which is the defect this marker exists to fix.
    expect(Object.hasOwn(patch.omp, "modelPrefix")).toBe(true);
    expect(patch.omp.modelPrefix).toBeNull();
  });

  it("does not emit an empty provider object", () => {
    expect(Object.keys(buildProviderModelPrefixPatch("omp", undefined))).toEqual(["omp"]);
    expect(Object.keys(buildProviderModelPrefixPatch("omp", undefined).omp)).toEqual([
      "modelPrefix",
    ]);
  });
});

describe("buildProviderSubModelPrefixPatch", () => {
  it("writes one sub-provider's tag without touching its siblings", () => {
    // The patch carries only the edited key: the map is merge-only, so naming
    // one sub-provider must not read as "the provider has only this tag".
    expect(buildProviderSubModelPrefixPatch("opencode", "anthropic", "Ant")).toEqual({
      opencode: { modelPrefixes: { anthropic: "Ant" } },
    });
  });

  it("marks a cleared sub-provider tag with an explicit null", () => {
    const patch = buildProviderSubModelPrefixPatch("opencode", "anthropic", undefined);

    expect(patch).toEqual({ opencode: { modelPrefixes: { anthropic: null } } });
    // An absent key would leave the stored tag in place forever; a null map
    // would be ambiguous with "leave the whole map alone".
    expect(Object.hasOwn(patch.opencode, "modelPrefixes")).toBe(true);
    expect(Object.hasOwn(patch.opencode.modelPrefixes!, "anthropic")).toBe(true);
    expect(patch.opencode.modelPrefixes!.anthropic).toBeNull();
  });

  it("never sends the provider-wide key alongside a per-sub-provider one", () => {
    // Sending both would let a per-sub save silently rewrite the fallback.
    expect(
      Object.keys(buildProviderSubModelPrefixPatch("opencode", "anthropic", "Ant").opencode),
    ).toEqual(["modelPrefixes"]);
  });

  it("carries a sub-provider id that is not a plain slug", () => {
    // Real ids include dots and long names, so the key must not be sanitized.
    expect(buildProviderSubModelPrefixPatch("opencode", "wafer.ai", "W")).toEqual({
      opencode: { modelPrefixes: { "wafer.ai": "W" } },
    });
  });
});
