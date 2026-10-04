import { describe, expect, test } from "vitest";

import { buildOmpLaunch } from "./runtime.js";
import { OmpHarness } from "./test-utils/omp-harness.js";

test("falls back to progress when the event subscription is unavailable", async () => {
  const omp = new OmpHarness();
  omp.failEventSubscription(new Error("events unsupported"));
  await omp.start();

  await expect(omp.waitForSubscriptionFallback()).resolves.toEqual(["events", "progress"]);
});

describe("buildOmpLaunch slim tool launch args", () => {
  test("launches the 64k baseline model with slim tools and no extensions", () => {
    const launch = buildOmpLaunch({
      command: ["omp"],
      session: { cwd: "/repo", model: "baseline-64k/local" },
    });

    expect(launch.argv).toEqual([
      "omp",
      "--mode",
      "rpc",
      "--tools",
      "read,bash,edit,write,grep,glob,todo,task",
      "--no-extensions",
      "--model",
      "baseline-64k/local",
    ]);
  });

  test("keeps the slim defaults out of other models", () => {
    const launch = buildOmpLaunch({
      command: ["omp"],
      session: { cwd: "/repo", model: "pioneer/canada-quant/glm-5.2" },
    });

    expect(launch.argv).toEqual([
      "omp",
      "--mode",
      "rpc",
      "--model",
      "pioneer/canada-quant/glm-5.2",
    ]);
  });

  test("leaves tool selection to the caller when extraArgs already set it", () => {
    const launch = buildOmpLaunch({
      command: ["omp"],
      session: {
        cwd: "/repo",
        model: "baseline-64k/local",
        extraArgs: ["--tools", "read,bash", "--no-extensions"],
      },
    });

    expect(launch.argv).toEqual([
      "omp",
      "--mode",
      "rpc",
      "--tools",
      "read,bash",
      "--no-extensions",
      "--model",
      "baseline-64k/local",
    ]);
  });

  test("does not override a caller that disabled tools entirely", () => {
    const launch = buildOmpLaunch({
      command: ["omp"],
      session: {
        cwd: "/repo",
        model: "baseline-64k/local",
        extraArgs: ["--no-tools"],
      },
    });

    expect(launch.argv).toEqual([
      "omp",
      "--mode",
      "rpc",
      "--no-tools",
      "--no-extensions",
      "--model",
      "baseline-64k/local",
    ]);
  });

  test("respects slim flags already present on the replaced command", () => {
    const launch = buildOmpLaunch({
      command: ["omp"],
      runtimeSettings: {
        command: { mode: "replace", argv: ["omp", "--tools=read,bash", "--no-extensions"] },
      },
      session: { cwd: "/repo", model: "baseline-64k/local" },
    });

    expect(launch.argv).toEqual([
      "omp",
      "--tools=read,bash",
      "--no-extensions",
      "--mode",
      "rpc",
      "--model",
      "baseline-64k/local",
    ]);
  });
});
