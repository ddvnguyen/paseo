import { describe, expect, it, test } from "vitest";

import type { AgentModelDefinition } from "./agent-sdk-types.js";
import {
  applyProviderContextCap,
  resolveProviderContextCap,
} from "./provider-model-context-cap.js";

function modelWithWindow(contextWindowMaxTokens: number | undefined): AgentModelDefinition {
  return {
    provider: "omp",
    id: "opencode-go/glm-5.3-flash",
    label: "GLM-5.3-Flash",
    contextWindowMaxTokens,
  };
}

describe("applyProviderContextCap", () => {
  test("leaves the model untouched when no ceiling is configured", () => {
    const model = modelWithWindow(1_000_000);

    expect(applyProviderContextCap(model, undefined)).toBe(model);
  });

  test("caps a reported window down to the gateway ceiling", () => {
    expect(applyProviderContextCap(modelWithWindow(1_000_000), 128_000)).toMatchObject({
      contextWindowMaxTokens: 128_000,
    });
  });

  test("never raises a window that is already under the ceiling", () => {
    expect(applyProviderContextCap(modelWithWindow(64_000), 128_000)).toMatchObject({
      contextWindowMaxTokens: 64_000,
    });
  });

  test("publishes the ceiling for a model whose catalog reports no window", () => {
    expect(applyProviderContextCap(modelWithWindow(undefined), 128_000)).toMatchObject({
      contextWindowMaxTokens: 128_000,
    });
  });

  test("caps the OpenCode limit.context mirror alongside the served field", () => {
    const model: AgentModelDefinition = {
      ...modelWithWindow(1_000_000),
      metadata: {
        providerId: "opencode-go",
        limit: { context: 1_000_000, input: 900_000, output: 128_000 },
      },
    };

    const capped = applyProviderContextCap(model, 128_000);

    expect(capped.metadata?.limit).toEqual({
      context: 128_000,
      input: 900_000,
      output: 128_000,
    });
  });

  test("fills limit.context with the ceiling when the catalog omits it", () => {
    const model: AgentModelDefinition = {
      ...modelWithWindow(undefined),
      metadata: { providerId: "opencode-go", limit: { output: 128_000 } },
    };

    expect(applyProviderContextCap(model, 128_000).metadata?.limit).toEqual({
      output: 128_000,
      context: 128_000,
    });
  });

  test("ignores a limit without a shape Paseo recognises", () => {
    const model: AgentModelDefinition = {
      ...modelWithWindow(1_000_000),
      metadata: { providerId: "opencode-go", limit: "unavailable" },
    };

    const capped = applyProviderContextCap(model, 128_000);

    expect(capped.metadata?.limit).toBe("unavailable");
    expect(capped.contextWindowMaxTokens).toBe(128_000);
  });
});

describe("resolveProviderContextCap", () => {
  it("passes a usable ceiling through", () => {
    expect(resolveProviderContextCap(280_000)).toBe(280_000);
  });

  // The registry mapper and the harness injection must agree, so both read the cap
  // through this one function. A non-positive or non-finite value means "no ceiling".
  it("treats non-positive and non-finite values as no ceiling", () => {
    expect(resolveProviderContextCap(0)).toBeUndefined();
    expect(resolveProviderContextCap(-1)).toBeUndefined();
    expect(resolveProviderContextCap(Number.NaN)).toBeUndefined();
    expect(resolveProviderContextCap(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(resolveProviderContextCap(undefined)).toBeUndefined();
  });

  it("agrees with the model cap for the same input", () => {
    const cap = resolveProviderContextCap(50_000);
    expect(
      applyProviderContextCap({ id: "m", label: "M", provider: "opencode" }, cap)
        .contextWindowMaxTokens,
    ).toBe(50_000);
  });
});
