import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { disabledModelsFilePath, readDisabledModels, setModelEnabled } from "./disabled-models.js";
import { assertModelSelectable, FREEBUFF_MODEL_IDS, listModels, modelState } from "./models.js";

let stateDir = "";

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-acp-models-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  stateDir = "";
});

function env(): NodeJS.ProcessEnv {
  return { FREEBUFF_ACP_STATE_DIR: stateDir };
}

describe("disabled-models store", () => {
  it("starts empty and tolerates a missing or corrupt file", () => {
    expect(readDisabledModels(env())).toEqual([]);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(disabledModelsFilePath(env()), "{corrupt");
    expect(readDisabledModels(env())).toEqual([]);
  });

  it("disables and re-enables a model with an atomic 0600 write", () => {
    expect(setModelEnabled("mimo/mimo-v2.5", false, FREEBUFF_MODEL_IDS, env())).toEqual({
      disabled: ["mimo/mimo-v2.5"],
    });
    expect(readDisabledModels(env())).toEqual(["mimo/mimo-v2.5"]);
    expect(fs.statSync(disabledModelsFilePath(env())).mode & 0o777).toBe(0o600);

    expect(setModelEnabled("mimo/mimo-v2.5", true, FREEBUFF_MODEL_IDS, env())).toEqual({
      disabled: [],
    });
    expect(readDisabledModels(env())).toEqual([]);
  });

  it("rejects unknown models and refuses to disable the last enabled model", () => {
    expect(() => setModelEnabled("nope", false, FREEBUFF_MODEL_IDS, env())).toThrow(
      /Unknown model/,
    );
    const ids = [...FREEBUFF_MODEL_IDS];
    for (const id of ids.slice(0, -1)) {
      setModelEnabled(id, false, FREEBUFF_MODEL_IDS, env());
    }
    expect(() => setModelEnabled(ids.at(-1)!, false, FREEBUFF_MODEL_IDS, env())).toThrow(
      /at least one model must stay enabled/,
    );
    // The refused disable left the store untouched.
    expect(readDisabledModels(env())).toHaveLength(ids.length - 1);
  });
});

describe("model catalog", () => {
  it("lists every catalog model enabled with probe prices when known", () => {
    const rows = listModels(env(), {
      dailyRemaining: 20,
      dailyLimit: 25,
      prices: { "z-ai/glm-5.3-flash": 5, "mimo/mimo-v2.5": 0 },
      priceNotices: { "z-ai/glm-5.3-flash": "peak hours" },
    });
    expect(rows.map((row) => row.id)).toEqual([...FREEBUFF_MODEL_IDS]);
    expect(rows.every((row) => row.enabled)).toBe(true);
    expect(rows.find((row) => row.id === "z-ai/glm-5.3-flash")).toMatchObject({
      name: "GLM 5.3 Flash",
      tagline: "Deep reasoning",
      priceFreebucks: 5,
      sessionLengthMs: 3_600_000,
      priceNotice: "peak hours",
    });
    expect(rows.find((row) => row.id === "mimo/mimo-v2.5")).toMatchObject({
      priceFreebucks: 0,
    });
    expect(rows.find((row) => row.id === "mimo/mimo-v2.5")?.priceNotice).toBeUndefined();
  });

  it("omits prices without a probe and flags disabled models", () => {
    setModelEnabled("mimo/mimo-v2.5", false, FREEBUFF_MODEL_IDS, env());
    const rows = listModels(env(), null);
    expect(rows.find((row) => row.id === "mimo/mimo-v2.5")).toMatchObject({ enabled: false });
    expect(rows.find((row) => row.id === "z-ai/glm-5.3-flash")).toMatchObject({ enabled: true });
    expect(rows.every((row) => row.priceFreebucks === undefined)).toBe(true);
    expect(rows.every((row) => row.sessionLengthMs === 3_600_000)).toBe(true);
  });

  it("modelState hides disabled models from the picker but keeps them selectable by id", () => {
    setModelEnabled("mimo/mimo-v2.5", false, FREEBUFF_MODEL_IDS, env());
    const state = modelState("mimo/mimo-v2.5", null, env());
    expect(state.currentModelId).toBe("mimo/mimo-v2.5");
    expect(state.availableModels.map((model) => model.modelId)).not.toContain("mimo/mimo-v2.5");
  });

  it("assertModelSelectable rejects unknown and disabled models only", () => {
    expect(() => assertModelSelectable("nope", env())).toThrow(/Unknown model/);
    expect(() => assertModelSelectable("z-ai/glm-5.3-flash", env())).not.toThrow();
    setModelEnabled("z-ai/glm-5.3-flash", false, FREEBUFF_MODEL_IDS, env());
    expect(() => assertModelSelectable("z-ai/glm-5.3-flash", env())).toThrow(/disabled/);
  });
});
