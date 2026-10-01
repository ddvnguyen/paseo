import { describe, expect, test } from "vitest";

import {
  applyOmpAgentDirEnv,
  resolveOmpProviderParams,
  type OmpRuntimeProviderParams,
} from "./provider-config.js";

describe("resolveOmpProviderParams agentDir", () => {
  test("leaves agentDir unset when the config declares none", () => {
    expect(resolveOmpProviderParams({}).runtimeProviderParams.agentDir).toBeUndefined();
  });

  test("carries a configured agentDir into the runtime params", () => {
    const params: OmpRuntimeProviderParams = resolveOmpProviderParams({
      agentDir: "/srv/omp-gateway",
    }).runtimeProviderParams;

    expect(params.agentDir).toBe("/srv/omp-gateway");
  });

  test("rejects an empty agentDir rather than silently falling back", () => {
    expect(() => resolveOmpProviderParams({ agentDir: "" })).toThrow();
  });
});

describe("applyOmpAgentDirEnv", () => {
  const agentDir = "/srv/omp-gateway";

  test("exports the agent dir as PI_CODING_AGENT_DIR", () => {
    expect(applyOmpAgentDirEnv({ command: { mode: "replace", argv: ["omp"] } }, agentDir)).toEqual({
      command: { mode: "replace", argv: ["omp"] },
      env: { PI_CODING_AGENT_DIR: agentDir },
    });
  });

  test("keeps existing env entries alongside the agent dir", () => {
    const merged = applyOmpAgentDirEnv({ env: { OPENCODE_API_KEY: "oc_sk_test" } }, agentDir);

    expect(merged?.env).toEqual({
      OPENCODE_API_KEY: "oc_sk_test",
      PI_CODING_AGENT_DIR: agentDir,
    });
  });

  test("an explicit env override wins over params.agentDir", () => {
    const settings = applyOmpAgentDirEnv(
      { env: { PI_CODING_AGENT_DIR: "/srv/explicit" } },
      agentDir,
    );

    expect(settings?.env?.PI_CODING_AGENT_DIR).toBe("/srv/explicit");
  });

  test("is a no-op without an agent dir", () => {
    const settings = { env: { OPENCODE_API_KEY: "oc_sk_test" } };

    expect(applyOmpAgentDirEnv(settings, undefined)).toBe(settings);
  });
});
