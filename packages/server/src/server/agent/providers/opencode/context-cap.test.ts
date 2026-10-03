import { describe, expect, it } from "vitest";

import {
  applyOpenCodeContextCaps,
  openCodeContextCapKey,
  openCodeContextCapsKey,
  type OpenCodeContextCapConfig,
  type OpenCodeModelContextCap,
} from "./context-cap.js";

function limitOf(config: OpenCodeContextCapConfig, providerId: string, modelId: string) {
  return config.provider?.[providerId]?.models?.[modelId]?.limit;
}

describe("opencode context cap injection", () => {
  // OpenCode's config schema declares `limit` as a closed `{ context, output }`
  // object and rejects the whole configuration when a key is missing, which takes
  // down every spawn rather than just this model. Both keys are therefore written.
  it("writes a complete limit carrying the model's own output ceiling", () => {
    const capped = applyOpenCodeContextCaps({}, [
      {
        providerId: "anthropic",
        modelId: "claude-sonnet-4",
        contextCap: 200_000,
        outputLimit: 64_000,
      },
    ]);

    expect(limitOf(capped, "anthropic", "claude-sonnet-4")).toEqual({
      context: 200_000,
      output: 64_000,
    });
  });

  it("preserves an output limit the config already set instead of clobbering it", () => {
    const base: OpenCodeContextCapConfig = {
      provider: { anthropic: { models: { m: { limit: { context: 900_000, output: 8_192 } } } } },
    };

    const capped = applyOpenCodeContextCaps(base, [
      { providerId: "anthropic", modelId: "m", contextCap: 200_000, outputLimit: 64_000 },
    ]);

    expect(limitOf(capped, "anthropic", "m")).toEqual({ context: 200_000, output: 8_192 });
  });

  // Without a usable output limit the only way to satisfy the schema is to invent
  // one, which would silently change the compaction threshold for a real model.
  it("skips a model with no output limit on either side", () => {
    const base: OpenCodeContextCapConfig = {};

    const capped = applyOpenCodeContextCaps(base, [
      { providerId: "p", modelId: "m", contextCap: 200_000 },
    ]);

    expect(capped).toBe(base);
    expect(capped.provider).toBeUndefined();
  });

  it("skips a model whose output limit is not a usable number", () => {
    const base: OpenCodeContextCapConfig = {};

    expect(
      applyOpenCodeContextCaps(base, [
        { providerId: "p", modelId: "zero", contextCap: 1_000, outputLimit: 0 },
        { providerId: "p", modelId: "nan", contextCap: 1_000, outputLimit: Number.NaN },
      ]),
    ).toBe(base);
  });

  // A cap may only ever lower a window. Raising it would let a "cap" enlarge a model.
  it("never raises a context value the config already set lower", () => {
    const base: OpenCodeContextCapConfig = {
      provider: { p: { models: { m: { limit: { context: 50_000 } } } } },
    };

    const capped = applyOpenCodeContextCaps(base, [
      { providerId: "p", modelId: "m", contextCap: 500_000, outputLimit: 64_000 },
    ]);

    expect(limitOf(capped, "p", "m")?.context).toBe(50_000);
  });

  it("is idempotent, so repeated decoration yields the same config", () => {
    const caps: OpenCodeModelContextCap[] = [
      { providerId: "anthropic", modelId: "m1", contextCap: 200_000, outputLimit: 64_000 },
      { providerId: "openai", modelId: "m2", contextCap: 100_000, outputLimit: 32_000 },
    ];

    const once = applyOpenCodeContextCaps({}, caps);
    const twice = applyOpenCodeContextCaps(once, caps);
    const thrice = applyOpenCodeContextCaps(twice, caps);

    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
    expect(limitOf(once, "anthropic", "m1")).toEqual({ context: 200_000, output: 64_000 });
    expect(limitOf(once, "openai", "m2")).toEqual({ context: 100_000, output: 32_000 });
  });

  it("does not mutate the input config", () => {
    const base: OpenCodeContextCapConfig = { provider: { p: { models: { m: {} } } } };
    const snapshot = structuredClone(base);

    applyOpenCodeContextCaps(base, [
      { providerId: "p", modelId: "m", contextCap: 1_000, outputLimit: 2_000 },
    ]);

    expect(base).toEqual(snapshot);
  });

  it("preserves unrelated config keys and sibling models", () => {
    const base: OpenCodeContextCapConfig = {
      model: "anthropic/claude-sonnet-4",
      provider: { p: { models: { other: { limit: { context: 10, output: 20 } } } } },
    };

    const capped = applyOpenCodeContextCaps(base, [
      { providerId: "p", modelId: "m", contextCap: 1_000, outputLimit: 2_000 },
    ]);

    expect(capped.model).toBe("anthropic/claude-sonnet-4");
    expect(limitOf(capped, "p", "other")).toEqual({ context: 10, output: 20 });
  });

  // A cap with no usable value, or a model with no id, must not create config entries.
  it("ignores non-positive, non-finite, and unnamed caps", () => {
    const base: OpenCodeContextCapConfig = {};

    const capped = applyOpenCodeContextCaps(base, [
      { providerId: "p", modelId: "zero", contextCap: 0, outputLimit: 1_000 },
      { providerId: "p", modelId: "negative", contextCap: -5, outputLimit: 1_000 },
      { providerId: "p", modelId: "nan", contextCap: Number.NaN, outputLimit: 1_000 },
      {
        providerId: "p",
        modelId: "infinite",
        contextCap: Number.POSITIVE_INFINITY,
        outputLimit: 1_000,
      },
      { providerId: "", modelId: "blank", contextCap: 1_000, outputLimit: 1_000 },
      { providerId: "p", modelId: "  ", contextCap: 1_000, outputLimit: 1_000 },
    ]);

    expect(capped).toBe(base);
    expect(capped.provider).toBeUndefined();
  });

  it("returns the same object when nothing needed changing", () => {
    const base: OpenCodeContextCapConfig = {};

    expect(applyOpenCodeContextCaps(base, [])).toBe(base);
  });

  it("builds an order-independent caps fingerprint and ignores unusable entries", () => {
    const caps: OpenCodeModelContextCap[] = [
      { providerId: "openai", modelId: "b", contextCap: 2, outputLimit: 20 },
      { providerId: "anthropic", modelId: "a", contextCap: 1, outputLimit: 10 },
    ];

    expect(openCodeContextCapsKey(caps)).toBe(
      openCodeContextCapsKey([
        { providerId: "anthropic", modelId: "a", contextCap: 1, outputLimit: 10 },
        { providerId: "openai", modelId: "b", contextCap: 2, outputLimit: 20 },
      ]),
    );
    expect(openCodeContextCapsKey([{ providerId: "p", modelId: "m", contextCap: 0 }])).toBe("");
  });

  // A model that only becomes cappable once its catalog entry reports an output
  // limit needs a fresh generation, or the cap stays inert until something else
  // happens to restart OpenCode.
  it("changes the fingerprint when a model's output limit appears", () => {
    const withoutOutput = openCodeContextCapsKey([
      { providerId: "p", modelId: "m", contextCap: 1_000 },
    ]);
    const withOutput = openCodeContextCapsKey([
      { providerId: "p", modelId: "m", contextCap: 1_000, outputLimit: 2_000 },
    ]);

    expect(withOutput).not.toBe(withoutOutput);
  });

  it("keys a model by provider and model id", () => {
    expect(openCodeContextCapKey("wafer.ai", "gpt-5")).toBe("wafer.ai/gpt-5");
  });
});
