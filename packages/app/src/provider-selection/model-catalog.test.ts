import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import { filterSelectableModels, findModelByReference } from "./model-catalog";

describe("findModelByReference", () => {
  it("prefers an exact model id over another model's alias", () => {
    const models: AgentModelDefinition[] = [
      {
        provider: "claude",
        id: "canonical-model",
        label: "Canonical model",
        aliases: ["gateway-model"],
      },
      {
        provider: "claude",
        id: "gateway-model",
        label: "Exact gateway model",
      },
    ];

    expect(findModelByReference(models, "gateway-model")?.label).toBe("Exact gateway model");
  });
});

describe("filterSelectableModels", () => {
  const models: AgentModelDefinition[] = [
    { provider: "claude", id: "m1", label: "M1" },
    { provider: "claude", id: "m2", label: "M2", isSelectable: false },
    { provider: "claude", id: "m3", label: "M3" },
  ];

  it("hides non-selectable models without an exclusion set", () => {
    expect(filterSelectableModels(models)?.map((model) => model.id)).toEqual(["m1", "m3"]);
  });

  it("treats an empty exclusion set as a no-op", () => {
    expect(filterSelectableModels(models, new Set())?.map((model) => model.id)).toEqual([
      "m1",
      "m3",
    ]);
  });

  it("excludes disabled ids by exact match only", () => {
    expect(filterSelectableModels(models, new Set(["m1", "mX"]))?.map((model) => model.id)).toEqual(
      ["m3"],
    );
  });

  it("passes null through", () => {
    expect(filterSelectableModels(null, new Set(["m1"]))).toBeNull();
  });
});
