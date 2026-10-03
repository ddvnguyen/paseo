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
  it("writes limit.context for the capped model", () => {
    const capped = applyOpenCodeContextCaps({}, [
      { providerId: "anthropic", modelId: "claude-sonnet-4", contextCap: 200_000 },
    ]);

    expect(limitOf(capped, "anthropic", "claude-sonnet-4")).toEqual({ context: 200_000 });
  });

  it("keeps the catalog's output limit alongside the capped context", () => {
    const base: OpenCodeContextCapConfig = {
      provider: { anthropic: { models: { m: { limit: { context: 900_000, output: 64_000 } } } } },
    };

    const capped = applyOpenCodeContextCaps(base, [
      { providerId: "anthropic", modelId: "m", contextCap: 200_000 },
    ]);

    expect(limitOf(capped, "anthropic", "m")).toEqual({ context: 200_000, output: 64_000 });
  });

  // A cap may only ever lower a window. Raising it would let a "cap" enlarge a model.
  it("never raises a context value the config already set lower", () => {
    const base: OpenCodeContextCapConfig = {
      provider: { p: { models: { m: { limit: { context: 50_000 } } } } },
    };

    const capped = applyOpenCodeContextCaps(base, [
      { providerId: "p", modelId: "m", contextCap: 500_000 },
    ]);

    expect(limitOf(capped, "p", "m")?.context).toBe(50_000);
  });

  it("is idempotent, so repeated decoration yields the same config", () => {
    const caps: OpenCodeModelContextCap[] = [
      { providerId: "anthropic", modelId: "m1", contextCap: 200_000 },
      { providerId: "openai", modelId: "m2", contextCap: 100_000 },
    ];

    const once = applyOpenCodeContextCaps({}, caps);
    const twice = applyOpenCodeContextCaps(once, caps);
    const thrice = applyOpenCodeContextCaps(twice, caps);

    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
    expect(limitOf(once, "anthropic", "m1")?.context).toBe(200_000);
    expect(limitOf(once, "openai", "m2")?.context).toBe(100_000);
  });

  it("does not mutate the input config", () => {
    const base: OpenCodeContextCapConfig = { provider: { p: { models: { m: {} } } } };
    const snapshot = structuredClone(base);

    applyOpenCodeContextCaps(base, [{ providerId: "p", modelId: "m", contextCap: 1_000 }]);

    expect(base).toEqual(snapshot);
  });

  it("preserves unrelated config keys and sibling models", () => {
    const base: OpenCodeContextCapConfig = {
      model: "anthropic/claude-sonnet-4",
      provider: { p: { models: { other: { limit: { context: 10 } } } } },
    };

    const capped = applyOpenCodeContextCaps(base, [
      { providerId: "p", modelId: "m", contextCap: 1_000 },
    ]);

    expect(capped.model).toBe("anthropic/claude-sonnet-4");
    expect(limitOf(capped, "p", "other")?.context).toBe(10);
  });

  // A cap with no usable value, or a model with no id, must not create config entries.
  it("ignores non-positive, non-finite, and unnamed caps", () => {
    const base: OpenCodeContextCapConfig = {};

    const capped = applyOpenCodeContextCaps(base, [
      { providerId: "p", modelId: "zero", contextCap: 0 },
      { providerId: "p", modelId: "negative", contextCap: -5 },
      { providerId: "p", modelId: "nan", contextCap: Number.NaN },
      { providerId: "p", modelId: "infinite", contextCap: Number.POSITIVE_INFINITY },
      { providerId: "", modelId: "blank", contextCap: 1_000 },
      { providerId: "p", modelId: "  ", contextCap: 1_000 },
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
      { providerId: "openai", modelId: "b", contextCap: 2 },
      { providerId: "anthropic", modelId: "a", contextCap: 1 },
    ];

    expect(openCodeContextCapsKey(caps)).toBe(
      openCodeContextCapsKey([
        { providerId: "anthropic", modelId: "a", contextCap: 1 },
        { providerId: "openai", modelId: "b", contextCap: 2 },
      ]),
    );
    expect(openCodeContextCapsKey([{ providerId: "p", modelId: "m", contextCap: 0 }])).toBe("");
  });

  it("keys a model by provider and model id", () => {
    expect(openCodeContextCapKey("wafer.ai", "gpt-5")).toBe("wafer.ai/gpt-5");
  });
});
