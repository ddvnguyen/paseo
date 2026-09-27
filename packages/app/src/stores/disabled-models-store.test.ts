import { beforeEach, describe, expect, it } from "vitest";
import { isLastEnabledModel, useDisabledModelsStore } from "./disabled-models-store";

const SERVER = "host-a";
const PROVIDER = "claude";

beforeEach(() => {
  useDisabledModelsStore.setState({ disabledByServerProvider: {} });
});

describe("useDisabledModelsStore", () => {
  it("disables and re-enables a model, pruning empty leaves", () => {
    const store = useDisabledModelsStore.getState();
    expect(store.isModelDisabled(SERVER, PROVIDER, "m1")).toBe(false);

    store.setModelDisabled(SERVER, PROVIDER, "m1", true);
    expect(useDisabledModelsStore.getState().isModelDisabled(SERVER, PROVIDER, "m1")).toBe(true);
    expect(useDisabledModelsStore.getState().getDisabledModelIds(SERVER, PROVIDER)).toEqual(["m1"]);

    // Duplicate writes stay deduped.
    store.setModelDisabled(SERVER, PROVIDER, "m1", true);
    expect(useDisabledModelsStore.getState().getDisabledModelIds(SERVER, PROVIDER)).toEqual(["m1"]);

    store.setModelDisabled(SERVER, PROVIDER, "m1", false);
    expect(useDisabledModelsStore.getState().isModelDisabled(SERVER, PROVIDER, "m1")).toBe(false);
    // Empty provider and server leaves are pruned.
    expect(useDisabledModelsStore.getState().disabledByServerProvider).toEqual({});
  });

  it("scopes the disable set per host and provider", () => {
    const store = useDisabledModelsStore.getState();
    store.setModelDisabled("host-a", "claude", "m1", true);
    store.setModelDisabled("host-b", "claude", "m2", true);
    store.setModelDisabled("host-a", "codex", "m1", true);

    const state = useDisabledModelsStore.getState();
    expect(state.getDisabledModelIds("host-a", "claude")).toEqual(["m1"]);
    expect(state.getDisabledModelIds("host-b", "claude")).toEqual(["m2"]);
    expect(state.getDisabledModelIds("host-a", "codex")).toEqual(["m1"]);
    expect(state.isModelDisabled("host-a", "codex", "m2")).toBe(false);
  });

  it("ignores blank keys", () => {
    const store = useDisabledModelsStore.getState();
    store.setModelDisabled("", PROVIDER, "m1", true);
    store.setModelDisabled(SERVER, "", "m1", true);
    store.setModelDisabled(SERVER, PROVIDER, "", true);
    expect(useDisabledModelsStore.getState().disabledByServerProvider).toEqual({});
    expect(store.isModelDisabled("", PROVIDER, "m1")).toBe(false);
    expect(store.getDisabledModelIds(SERVER, "")).toEqual([]);
  });
});

describe("isLastEnabledModel", () => {
  it("detects the last remaining enabled model", () => {
    expect(isLastEnabledModel(["m1"], ["m1", "m2"], "m2")).toBe(true);
    expect(isLastEnabledModel([], ["m1", "m2"], "m1")).toBe(false);
    // Already-disabled rows are never the last enabled one.
    expect(isLastEnabledModel(["m1"], ["m1", "m2"], "m1")).toBe(false);
    // Unknown ids are outside the catalog.
    expect(isLastEnabledModel([], ["m1"], "mX")).toBe(false);
    // Single-model provider: its only model is last.
    expect(isLastEnabledModel([], ["m1"], "m1")).toBe(true);
  });
});
