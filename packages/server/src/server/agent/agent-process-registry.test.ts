import { describe, expect, test, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { resolvePaseoHome } from "../paseo-home.js";
import {
  classifyAgentProcessEntry,
  forgetAgentProcess,
  readAgentProcessRegistry,
  recordAgentProcess,
  reapStaleAgentProcesses,
  resolveAgentProcessRegistryPath,
  setAgentProcessRegistryHome,
  type AgentProcessEntry,
} from "./agent-process-registry.js";

const logger = createTestLogger();

function buildEntry(overrides: Partial<AgentProcessEntry> = {}): AgentProcessEntry {
  return {
    scopeId: "paseo-agent-test-1",
    unit: "paseo-agent-test-1.scope",
    pid: 4242,
    provider: "opencode",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("agent process registry", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-process-registry-"));
    filePath = path.join(tmpDir, "agent-processes.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    setAgentProcessRegistryHome(null);
  });

  test("records entries with an atomic write and no temp leftovers", () => {
    const recorded = recordAgentProcess(buildEntry(), { filePath, logger });
    expect(recorded).toBe(true);

    // A temp-file + rename write leaves only the final file behind.
    expect(readdirSync(tmpDir)).toEqual(["agent-processes.json"]);

    const entries = readAgentProcessRegistry({ filePath, logger });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      scopeId: "paseo-agent-test-1",
      unit: "paseo-agent-test-1.scope",
      pid: 4242,
      provider: "opencode",
    });
    expect(entries[0].startedAt).toBeTruthy();
  });

  test("recovers from a corrupt registry file", () => {
    writeFileSync(filePath, "{ this is not json !!");
    expect(readAgentProcessRegistry({ filePath, logger })).toEqual([]);

    // A successful record replaces the corrupt content.
    expect(recordAgentProcess(buildEntry({ pid: 7 }), { filePath, logger })).toBe(true);
    expect(readAgentProcessRegistry({ filePath })).toHaveLength(1);

    // Wrong shape counts as corrupt too.
    writeFileSync(filePath, JSON.stringify({ pid: 1 }));
    expect(readAgentProcessRegistry({ filePath, logger })).toEqual([]);

    // A reaper on a corrupt file degrades to an empty result, then rewrites cleanly.
    const result = reapStaleAgentProcesses({ filePath, logger });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(recordAgentProcess(buildEntry({ pid: 9 }), { filePath, logger })).toBe(true);
    expect(readAgentProcessRegistry({ filePath })).toHaveLength(1);
  });

  test("adds, replaces and removes entries", () => {
    recordAgentProcess(buildEntry(), { filePath, logger });
    recordAgentProcess(
      buildEntry({ scopeId: "paseo-agent-test-2", unit: "paseo-agent-test-2.scope", pid: 4243 }),
      {
        filePath,
        logger,
      },
    );
    expect(readAgentProcessRegistry({ filePath })).toHaveLength(2);

    // Recording the same pid replaces rather than duplicates.
    recordAgentProcess(buildEntry({ pid: 4242, startedAt: "2026-01-01T00:00:00.000Z" }), {
      filePath,
      logger,
    });
    const afterReplace = readAgentProcessRegistry({ filePath });
    expect(afterReplace).toHaveLength(2);
    expect(afterReplace.find((entry) => entry.pid === 4242)?.startedAt).toBe(
      "2026-01-01T00:00:00.000Z",
    );

    expect(forgetAgentProcess(4242, { filePath, logger })).toBe(true);
    const afterRemove = readAgentProcessRegistry({ filePath });
    expect(afterRemove).toHaveLength(1);
    expect(afterRemove[0].pid).toBe(4243);

    // Forgetting an unknown pid is an idempotent no-op.
    expect(forgetAgentProcess(9999, { filePath, logger })).toBe(true);
    expect(readAgentProcessRegistry({ filePath })).toHaveLength(1);

    // Forgetting when the file is gone does not resurrect it.
    rmSync(filePath);
    expect(forgetAgentProcess(4243, { filePath, logger })).toBe(true);
    expect(readAgentProcessRegistry({ filePath })).toEqual([]);
  });

  test("pins the registry path to an explicit daemon home and reverts to env", () => {
    setAgentProcessRegistryHome(tmpDir);
    expect(resolveAgentProcessRegistryPath()).toBe(path.join(tmpDir, "agent-processes.json"));

    setAgentProcessRegistryHome(null);
    expect(resolveAgentProcessRegistryPath()).toBe(
      path.join(resolvePaseoHome(), "agent-processes.json"),
    );
  });
});

// /proc-based classification only exists on Linux; off Linux the reaper keeps
// live entries by design.
describe.runIf(process.platform === "linux")("agent process reaper", () => {
  let tmpDir: string;
  let filePath: string;
  const liveChildren: ReturnType<typeof spawn>[] = [];

  function spawnLongRunning(args: string[]): number {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], {
      stdio: "ignore",
    });
    liveChildren.push(child);
    if (typeof child.pid !== "number") {
      throw new Error("failed to spawn probe process");
    }
    return child.pid;
  }

  async function waitUntilMatches(pid: number, provider: string): Promise<void> {
    await expect
      .poll(() => classifyAgentProcessEntry(buildEntry({ pid, provider })), { timeout: 5_000 })
      .toBe("live-matching");
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-process-reaper-"));
    filePath = path.join(tmpDir, "agent-processes.json");
  });

  afterEach(() => {
    for (const child of liveChildren.splice(0)) {
      child.kill("SIGKILL");
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("classifies a dead pid as dead", () => {
    const finished = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect(finished.pid).toBeGreaterThan(0);
    expect(classifyAgentProcessEntry(buildEntry({ pid: finished.pid as number }))).toBe("dead");
    expect(classifyAgentProcessEntry(buildEntry({ pid: 999_999_999 }))).toBe("dead");
  });

  test("classifies an alive pid that is not the provider as recycled", () => {
    const pid = spawnLongRunning(["--unrelated-marker=elsewhere"]);
    expect(classifyAgentProcessEntry(buildEntry({ pid, provider: "opencode" }))).toBe("recycled");
  });

  test("classifies an alive pid matching the provider marker as live-matching", async () => {
    const pid = spawnLongRunning(["--provider-marker=opencode"]);
    await waitUntilMatches(pid, "opencode");
  });

  test("reaper removes dead and recycled entries and preserves live matching ones", async () => {
    const deadPid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;
    const recycledPid = spawnLongRunning(["--unrelated-marker=elsewhere"]);
    const livePid = spawnLongRunning(["--provider-marker=opencode"]);
    await waitUntilMatches(livePid, "opencode");

    recordAgentProcess(buildEntry({ scopeId: "dead-1", unit: "dead-1.scope", pid: deadPid }), {
      filePath,
      logger,
    });
    recordAgentProcess(
      buildEntry({ scopeId: "recycled-1", unit: "recycled-1.scope", pid: recycledPid }),
      { filePath, logger },
    );
    recordAgentProcess(buildEntry({ scopeId: "live-1", unit: "live-1.scope", pid: livePid }), {
      filePath,
      logger,
    });

    const result = reapStaleAgentProcesses({ filePath, logger });

    expect(result.removed.map((entry) => entry.scopeId).sort()).toEqual(["dead-1", "recycled-1"]);
    expect(result.kept.map((entry) => entry.scopeId)).toEqual(["live-1"]);

    const remaining = readAgentProcessRegistry({ filePath });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pid).toBe(livePid);

    // The reaper only prunes records — it never signals processes.
    expect(() => process.kill(livePid, 0)).not.toThrow();
    expect(() => process.kill(recycledPid, 0)).not.toThrow();
  });
});
