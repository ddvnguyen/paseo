import { describe, expect, test, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import pino from "pino";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { resolvePaseoHome } from "../paseo-home.js";
import {
  AGENT_PROCESS_UNOWNED_RECORD_TTL_MS,
  __setAgentProcessCgroupReaderForTests,
  classifyAgentProcessEntry,
  flushLiveAgentProcesses,
  forgetAgentProcess,
  getAgentProcessOwnerDaemonId,
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

interface SpawnedProbe {
  pid: number;
  readyFile: string;
}

let probeSequence = 0;

/**
 * Long-running probe process that signals readiness by writing a file once it
 * is actually executing. `--` keeps marker flags out of node's own option
 * parsing — without it node rejects the flag and exits 9 before running the
 * script, so readiness would never be written.
 */
function spawnProbe(
  tmpDir: string,
  children: ReturnType<typeof spawn>[],
  args: string[],
): SpawnedProbe {
  const readyFile = path.join(tmpDir, `probe-ready-${probeSequence++}`);
  const probeCode = `require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));setInterval(() => {}, 1000)`;
  const child = spawn(process.execPath, ["-e", probeCode, "--", ...args], { stdio: "ignore" });
  children.push(child);
  if (typeof child.pid !== "number") {
    throw new Error("failed to spawn probe process");
  }
  return { pid: child.pid, readyFile };
}

/**
 * Wait for the probe's explicit readiness signal, then assert the probe is
 * genuinely alive at classification time. A regression that kills the probe
 * (e.g. a rejected node flag) fails here instead of passing by winning a
 * sampling race.
 */
async function waitUntilProbeReady(probe: SpawnedProbe): Promise<void> {
  await expect.poll(() => existsSync(probe.readyFile), { timeout: 5_000 }).toBe(true);
  expectPidAlive(probe.pid, "probe must still be alive after signalling readiness");
}

function expectPidAlive(pid: number, context: string): void {
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive, `${context} (pid ${pid})`).toBe(true);
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

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-process-reaper-"));
    filePath = path.join(tmpDir, "agent-processes.json");
  });

  afterEach(() => {
    for (const child of liveChildren.splice(0)) {
      child.kill("SIGKILL");
    }
    __setAgentProcessCgroupReaderForTests(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("classifies a dead pid as dead", () => {
    const finished = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect(finished.pid).toBeGreaterThan(0);
    expect(classifyAgentProcessEntry(buildEntry({ pid: finished.pid as number }))).toBe("dead");
    expect(classifyAgentProcessEntry(buildEntry({ pid: 999_999_999 }))).toBe("dead");
  });

  test("classifies an alive pid that is not the provider as recycled", async () => {
    const probe = spawnProbe(tmpDir, liveChildren, ["--unrelated-marker=elsewhere"]);
    await waitUntilProbeReady(probe);
    expect(classifyAgentProcessEntry(buildEntry({ pid: probe.pid, provider: "opencode" }))).toBe(
      "recycled",
    );
  });

  test("classifies an alive pid matching the provider marker as live-matching", async () => {
    const probe = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(probe);
    expect(classifyAgentProcessEntry(buildEntry({ pid: probe.pid, provider: "opencode" }))).toBe(
      "live-matching",
    );
  });

  test("reaper removes dead and recycled entries and preserves live matching ones", async () => {
    const deadPid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;
    const recycled = spawnProbe(tmpDir, liveChildren, ["--unrelated-marker=elsewhere"]);
    const live = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(recycled);
    await waitUntilProbeReady(live);

    recordAgentProcess(buildEntry({ scopeId: "dead-1", unit: "dead-1.scope", pid: deadPid }), {
      filePath,
      logger,
    });
    recordAgentProcess(
      buildEntry({ scopeId: "recycled-1", unit: "recycled-1.scope", pid: recycled.pid }),
      { filePath, logger },
    );
    recordAgentProcess(buildEntry({ scopeId: "live-1", unit: "live-1.scope", pid: live.pid }), {
      filePath,
      logger,
    });

    // Both surviving probes are verifiably alive at classification time.
    expectPidAlive(recycled.pid, "recycled probe is alive at reap time");
    expectPidAlive(live.pid, "live probe is alive at reap time");

    const result = reapStaleAgentProcesses({ filePath, logger });

    expect(result.removed.map((entry) => entry.scopeId).sort()).toEqual(["dead-1", "recycled-1"]);
    expect(result.kept.map((entry) => entry.scopeId)).toEqual(["live-1"]);

    const remaining = readAgentProcessRegistry({ filePath });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pid).toBe(live.pid);

    // The reaper only prunes records — it never signals processes.
    expectPidAlive(live.pid, "live probe survives the reaper");
    expectPidAlive(recycled.pid, "recycled probe survives the reaper");
  });

  test("reaps an expired unowned live record with a loud scope-naming warning", async () => {
    const logs: string[] = [];
    const captureLogger = pino({ level: "warn" }, { write: (line) => logs.push(line) });
    const probe = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(probe);

    const expiredAt = new Date(
      Date.now() - AGENT_PROCESS_UNOWNED_RECORD_TTL_MS - 60_000,
    ).toISOString();
    recordAgentProcess(
      buildEntry({
        scopeId: "orphan-1",
        unit: "orphan-1.scope",
        pid: probe.pid,
        ownerDaemonId: "previous-daemon-generation",
        startedAt: expiredAt,
      }),
      { filePath, logger: captureLogger },
    );

    const result = reapStaleAgentProcesses({ filePath, logger: captureLogger });

    expect(result.removed.map((entry) => entry.scopeId)).toEqual(["orphan-1"]);
    expect(result.kept).toEqual([]);
    const warning = logs.find((line) => line.includes("expired unowned agent scope record"));
    expect(warning, "reaper logs a loud warning for the expired record").toBeTruthy();
    expect(warning).toContain("orphan-1.scope");
    expect(warning).toContain(String(probe.pid));

    // Dropping the record never signals the child.
    expectPidAlive(probe.pid, "expired-orphan probe survives the reaper");
  });

  test("keeps fresh unowned records and expired records owned by this daemon", async () => {
    const freshUnowned = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    const expiredOwned = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(freshUnowned);
    await waitUntilProbeReady(expiredOwned);

    const expiredAt = new Date(
      Date.now() - AGENT_PROCESS_UNOWNED_RECORD_TTL_MS - 60_000,
    ).toISOString();
    recordAgentProcess(
      buildEntry({
        scopeId: "fresh-unowned",
        unit: "fresh-unowned.scope",
        pid: freshUnowned.pid,
        ownerDaemonId: "previous-daemon-generation",
      }),
      { filePath, logger },
    );
    // Owner omitted: recordAgentProcess stamps this daemon's generation.
    recordAgentProcess(
      buildEntry({
        scopeId: "expired-owned",
        unit: "expired-owned.scope",
        pid: expiredOwned.pid,
        startedAt: expiredAt,
      }),
      { filePath, logger },
    );

    const result = reapStaleAgentProcesses({ filePath, logger });

    expect(result.removed).toEqual([]);
    expect(result.kept.map((entry) => entry.scopeId).sort()).toEqual([
      "expired-owned",
      "fresh-unowned",
    ]);
    expect(readAgentProcessRegistry({ filePath })).toHaveLength(2);
    // Sanity: the stamp used for ownership is the current process generation.
    expect(
      readAgentProcessRegistry({ filePath }).find((entry) => entry.scopeId === "expired-owned")
        ?.ownerDaemonId,
    ).toBe(getAgentProcessOwnerDaemonId());
  });
});

// Scope-membership identity: the primary check the reaper uses so a live child
// whose cmdline lacks the provider id (ACP spawns `claude` for provider
// `claude-acp`) is never misclassified and orphaned.
describe.runIf(process.platform === "linux")("agent process identity", () => {
  let tmpDir: string;
  let filePath: string;
  const liveChildren: ReturnType<typeof spawn>[] = [];

  function scopeCgroup(scopeName: string): string {
    return `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${scopeName}\n`;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-process-identity-"));
    filePath = path.join(tmpDir, "agent-processes.json");
  });

  afterEach(() => {
    for (const child of liveChildren.splice(0)) {
      child.kill("SIGKILL");
    }
    __setAgentProcessCgroupReaderForTests(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("keeps a live pid in the expected scope even when cmdline lacks the provider id", async () => {
    // The exact ACP misclassification: real child, provider id never appears in
    // its cmdline, scope membership is the only sound identity signal.
    const probe = spawnProbe(tmpDir, liveChildren, ["--unrelated-marker=elsewhere"]);
    await waitUntilProbeReady(probe);
    const entry = buildEntry({
      scopeId: "paseo-agent-test-1",
      unit: "paseo-agent-test-1.scope",
      pid: probe.pid,
      provider: "claude-acp",
    });
    __setAgentProcessCgroupReaderForTests((pid) =>
      pid === probe.pid ? scopeCgroup("paseo-agent-test-1.scope") : null,
    );

    expect(classifyAgentProcessEntry(entry)).toBe("live-matching");

    // And through the reaper end to end: the record survives.
    recordAgentProcess(entry, { filePath, logger });
    const result = reapStaleAgentProcesses({ filePath, logger });
    expect(result.removed).toEqual([]);
    expect(result.kept.map((kept) => kept.scopeId)).toEqual(["paseo-agent-test-1"]);
  });

  test("removes a live pid in a different scope even when cmdline matches the provider", async () => {
    const probe = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(probe);
    __setAgentProcessCgroupReaderForTests((pid) =>
      pid === probe.pid ? scopeCgroup("paseo-agent-someone-else.scope") : null,
    );

    expect(classifyAgentProcessEntry(buildEntry({ pid: probe.pid, provider: "opencode" }))).toBe(
      "recycled",
    );
  });

  test("falls back to the provider marker when the entry has no live scope membership", async () => {
    // Scope-less legacy entry: the pid is alive but carries no scope cgroup, so
    // membership cannot speak and the documented marker fallback decides.
    const matching = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    const nonMatching = spawnProbe(tmpDir, liveChildren, ["--unrelated-marker=elsewhere"]);
    await waitUntilProbeReady(matching);
    await waitUntilProbeReady(nonMatching);
    __setAgentProcessCgroupReaderForTests(() => "0::/\n");

    expect(
      classifyAgentProcessEntry(
        buildEntry({ scopeId: "legacy-1", unit: "legacy-1.scope", pid: matching.pid }),
      ),
    ).toBe("live-matching");
    expect(
      classifyAgentProcessEntry(
        buildEntry({ scopeId: "legacy-1", unit: "legacy-1.scope", pid: nonMatching.pid }),
      ),
    ).toBe("recycled");
  });
});

// The detach-stop flush is liveness-only: it must keep whatever is still
// running (a child adopted by the next daemon) and drop only dead pids,
// regardless of the provider marker the reaper checks.
describe("agent process flush (detach stop)", () => {
  let tmpDir: string;
  let filePath: string;
  const liveChildren: ReturnType<typeof spawn>[] = [];

  function spawnLongRunning(): number {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    liveChildren.push(child);
    if (typeof child.pid !== "number") {
      throw new Error("failed to spawn flush probe process");
    }
    return child.pid;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-process-flush-"));
    filePath = path.join(tmpDir, "agent-processes.json");
  });

  afterEach(() => {
    for (const child of liveChildren.splice(0)) {
      child.kill("SIGKILL");
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("keeps live entries, drops dead ones, and writes only when something was removed", () => {
    const deadPid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;
    const livePid = spawnLongRunning();

    recordAgentProcess(
      buildEntry({ scopeId: "flush-dead", unit: "flush-dead.scope", pid: deadPid }),
      { filePath, logger },
    );
    recordAgentProcess(
      buildEntry({ scopeId: "flush-live", unit: "flush-live.scope", pid: livePid }),
      { filePath, logger },
    );

    const result = flushLiveAgentProcesses({ filePath, logger });
    expect(result.kept.map((entry) => entry.scopeId)).toEqual(["flush-live"]);
    expect(result.removed.map((entry) => entry.scopeId)).toEqual(["flush-dead"]);

    const remaining = readAgentProcessRegistry({ filePath });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pid).toBe(livePid);

    // Flushing again with nothing dead leaves the survivors untouched.
    const again = flushLiveAgentProcesses({ filePath, logger });
    expect(again.kept.map((entry) => entry.pid)).toEqual([livePid]);
    expect(again.removed).toEqual([]);
  });

  test("degrades to an empty result when the registry file is missing", () => {
    const result = flushLiveAgentProcesses({ filePath, logger });
    expect(result).toEqual({ kept: [], removed: [] });
    expect(readAgentProcessRegistry({ filePath })).toEqual([]);
  });
});
