import { describe, expect, it } from "vitest";
import {
  clearedContextUsageUpdate,
  contextTokensOf,
  contextUsageUpdate,
  contextWindowFor,
} from "./context-usage.js";

const runState = { mainAgentState: { contextTokenCount: 4200, messageHistory: [] } };

describe("contextUsageUpdate", () => {
  it("reports used tokens with the model's window from the CLI table", () => {
    expect(contextUsageUpdate(runState, "z-ai/glm-5.3-flash")).toEqual({
      sessionUpdate: "usage_update",
      used: 4200,
      size: 1_000_000,
    });
    expect(contextWindowFor("minimax/minimax-m3")).toBe(524_288);
  });

  it("falls back to the CLI's default window for models missing from the table", () => {
    expect(contextWindowFor("some/future-model")).toBe(131_072);
    expect(contextUsageUpdate(runState, "some/future-model")).toMatchObject({ size: 131_072 });
  });

  it("reports nothing when no count is recorded, so a lost context is not claimed", () => {
    expect(contextUsageUpdate(null, "z-ai/glm-5.3-flash")).toBeNull();
    expect(contextUsageUpdate({ mainAgentState: {} }, "z-ai/glm-5.3-flash")).toBeNull();
    expect(contextTokensOf({ mainAgentState: { contextTokenCount: "12" } })).toBeUndefined();
    expect(contextTokensOf({ mainAgentState: { contextTokenCount: -1 } })).toBeUndefined();
  });
});

describe("context window table", () => {
  // Copy of FREEBUFF_MODEL_CONTEXT_WINDOWS in the Freebuff CLI (external/freebuff,
  // common/src/constants/freebuff-models.ts). A typo in the adapter's table would
  // silently fall back to the default, so every row is pinned here.
  const cliTable: Record<string, number> = {
    "minimax/minimax-m3": 524_288,
    "deepseek/deepseek-v4-flash": 1_048_576,
    "deepseek/deepseek-v4-pro": 1_048_576,
    "openai/gpt-5.6-luna": 1_000_000,
    "openai/gpt-6-luna": 1_000_000,
    "openai/gpt-5.6-luna-es": 372_000,
    "meta/muse-spark-1.2-contributor": 1_000_000,
    "stealth/ox-alpha": 1_000_000,
    "z-ai/glm-5.3-flash": 1_000_000,
    "upstage/solar-pro4": 500_000,
    "upstage/solar-mini4": 500_000,
    "stealth/space-bunny-alpha": 1_000_000,
  };

  it.each(Object.entries(cliTable))("%s has window %i", (modelId, window) => {
    expect(contextWindowFor(modelId)).toBe(window);
  });
});

describe("clearedContextUsageUpdate", () => {
  it("resets used to 0 against the model's window", () => {
    expect(clearedContextUsageUpdate("minimax/minimax-m3")).toEqual({
      sessionUpdate: "usage_update",
      used: 0,
      size: 524_288,
    });
  });
});
