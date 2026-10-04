import { describe, expect, test, afterEach, beforeEach } from "vitest";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { readAgentProcessRegistry } from "./agent-process-registry.js";
import {
  __setAgentProcessScopeDetectionForTests,
  buildAgentScopeInvocation,
  spawnInAgentScope,
} from "./agent-process-scope.js";

const logger = createTestLogger();

describe("buildAgentScopeInvocation", () => {
  test("wraps the command in a transient systemd scope", () => {
    const invocation = buildAgentScopeInvocation("opencode", ["serve", "--port", "1234"]);
    expect(invocation.command).toBe("systemd-run");
    expect(invocation.scopeId).toMatch(/^paseo-agent-\d+-[0-9a-f]{12}$/);
    expect(invocation.unit).toBe(`${invocation.scopeId}.scope`);
    expect(invocation.args).toContain("--user");
    expect(invocation.args).toContain("--scope");
    expect(invocation.args).toContain("--quiet");
    expect(invocation.args).toContain("--property=KillMode=process");
    expect(invocation.args).toContain("--collect");
    const separator = invocation.args.indexOf("--");
    expect(separator).toBeGreaterThan(0);
    expect(invocation.args.slice(separator + 1)).toEqual(["opencode", "serve", "--port", "1234"]);
  });
});

describe("spawnInAgentScope", () => {
  let tmpDir: string;
  let previousPaseoHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-process-scope-"));
    previousPaseoHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = tmpDir;
  });

  afterEach(() => {
    __setAgentProcessScopeDetectionForTests(null);
    if (previousPaseoHome === undefined) {
      delete process.env.PASEO_HOME;
    } else {
      process.env.PASEO_HOME = previousPaseoHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("falls back to a plain spawn when the scope is unavailable", async () => {
    __setAgentProcessScopeDetectionForTests({ available: false, reason: "forced by test" });
    const child = spawnInAgentScope(
      process.execPath,
      ["-e", "setTimeout(() => {}, 100)"],
      { stdio: "ignore" },
      { provider: "scope-test", logger },
    );
    expect(child.pid).toBeGreaterThan(0);
    expect(child.spawnfile).toBe(process.execPath);
    // A plain spawn records nothing in the scope registry.
    expect(
      readAgentProcessRegistry({ filePath: path.join(tmpDir, "agent-processes.json") }),
    ).toEqual([]);
    await once(child, "close");
  });

  test("spawns through systemd-run when the scope is available and records an entry", async () => {
    __setAgentProcessScopeDetectionForTests({ available: true, reason: "forced by test" });
    const child = spawnInAgentScope(
      process.execPath,
      ["-e", "setTimeout(() => {}, 50)"],
      { stdio: "ignore" },
      { provider: "scope-test", logger },
    );
    expect(child.pid).toBeGreaterThan(0);
    expect(String(child.spawnfile)).toContain("systemd-run");

    const entries = readAgentProcessRegistry({
      filePath: path.join(tmpDir, "agent-processes.json"),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBe(child.pid);
    expect(entries[0].provider).toBe("scope-test");
    expect(entries[0].unit).toMatch(/\.scope$/);

    await once(child, "close");
    expect(
      readAgentProcessRegistry({ filePath: path.join(tmpDir, "agent-processes.json") }),
    ).toEqual([]);
  });
});
