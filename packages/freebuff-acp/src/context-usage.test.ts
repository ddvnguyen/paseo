import { describe, expect, it } from "vitest";
import { contextTokensOf, contextUsageUpdate, contextWindowFor } from "./context-usage.js";

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
