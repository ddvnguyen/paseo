import { describe, expect, test } from "vitest";

import type { AgentModelDefinition } from "./agent-sdk-types.js";
import { applyProviderContextCap } from "./provider-model-context-cap.js";

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
