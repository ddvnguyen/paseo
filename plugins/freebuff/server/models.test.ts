import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  freebuffModelsList,
  freebuffModelsSetEnabled,
  sessionLifetimeLabel,
} from "../shared/models.js";
import { listModels, setModelEnabled } from "./models.js";
import { runAdapterJson } from "./adapter-cli.js";

vi.mock("./adapter-cli.js", () => ({ runAdapterJson: vi.fn() }));

const runAdapterJsonMock = vi.mocked(runAdapterJson);

beforeEach(() => {
  runAdapterJsonMock.mockReset();
});

const ADAPTER_ROWS = [
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    tagline: "Deep reasoning",
    priceFreebucks: 5,
    sessionLengthMs: 3_600_000,
    priceNotice: "peak hours",
    enabled: true,
  },
  {
    id: "mimo/mimo-v2.5",
    name: "MiMo 2.6 Flash",
    tagline: "Balanced",
    sessionLengthMs: 3_600_000,
    enabled: false,
  },
];

describe("sessionLifetimeLabel", () => {
  it("renders whole hours, minutes, and raw milliseconds", () => {
    expect(sessionLifetimeLabel(3_600_000)).toBe("1h");
    expect(sessionLifetimeLabel(7_200_000)).toBe("2h");
    expect(sessionLifetimeLabel(60_000)).toBe("1m");
    expect(sessionLifetimeLabel(5_000)).toBe("5000ms");
  });
});

describe("freebuff.models.list", () => {
  it("translates adapter rows to the display contract", async () => {
    runAdapterJsonMock.mockResolvedValue(ADAPTER_ROWS);

    const result = await listModels();

    expect(runAdapterJsonMock).toHaveBeenCalledWith(["models", "list"]);
    expect(result).toEqual({
      models: [
        {
          id: "z-ai/glm-5.3-flash",
          name: "GLM 5.3 Flash",
          tagline: "Deep reasoning",
          priceFreebucks: 5,
          sessionLifetimeLabel: "1h",
          priceNotices: "peak hours",
          enabled: true,
        },
        {
          id: "mimo/mimo-v2.5",
          name: "MiMo 2.6 Flash",
          tagline: "Balanced",
          sessionLifetimeLabel: "1h",
          enabled: false,
        },
      ],
    });
    // The translated payload satisfies the RPC output contract.
    expect(() => freebuffModelsList.output.parse(result)).not.toThrow();
  });

  it("warns via modelCheck when no row carries a price", async () => {
    runAdapterJsonMock.mockResolvedValue([
      {
        id: "z-ai/glm-5.3-flash",
        name: "GLM 5.3 Flash",
        tagline: "Deep reasoning",
        sessionLengthMs: 3_600_000,
        enabled: true,
      },
    ]);

    const result = await listModels();

    expect(result.modelCheck).toMatch(/prices unavailable/);
    expect(() => freebuffModelsList.output.parse(result)).not.toThrow();
  });
});

describe("freebuff.models.set-enabled", () => {
  it("passes id/enabled through to the adapter CLI", async () => {
    runAdapterJsonMock.mockResolvedValue({ disabled: ["mimo/mimo-v2.5"] });

    const result = await setModelEnabled({ id: "mimo/mimo-v2.5", enabled: false });

    expect(runAdapterJsonMock).toHaveBeenCalledWith([
      "models",
      "set-enabled",
      "--id",
      "mimo/mimo-v2.5",
      "--enabled",
      "false",
    ]);
    expect(result).toEqual({ disabled: ["mimo/mimo-v2.5"] });
  });

  it("surfaces the last-enabled refusal as a clean RPC error", async () => {
    runAdapterJsonMock.mockRejectedValue(
      new Error('Cannot disable "z-ai/glm-5.3-flash": at least one model must stay enabled.'),
    );

    await expect(setModelEnabled({ id: "z-ai/glm-5.3-flash", enabled: false })).rejects.toThrow(
      'Cannot disable "z-ai/glm-5.3-flash": at least one model must stay enabled.',
    );
  });

  it("requires a boolean enabled flag", () => {
    expect(() => freebuffModelsSetEnabled.input.parse({ id: "x", enabled: "true" })).toThrow();
    expect(freebuffModelsSetEnabled.input.parse({ id: "x", enabled: true })).toEqual({
      id: "x",
      enabled: true,
    });
  });
});
