import { describe, expect, test, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  isPidRunning,
  isSignalableAgentScopeUnit,
  readAgentProcessRegistry,
  recordAgentProcess,
  reapStaleAgentProcesses,
  resolveAgentProcessRegistryPath,
  setAgentProcessRegistryHome,
  type AgentProcessEntry,
} from "./agent-process-registry.js";
import {
  __setAgentProcessScopeDetectionForTests,
  __setAgentProcessScopeProbeForTests,
  probeAgentScopeRoundTrip,
  spawnInAgentScope,
} from "./agent-process-scope.js";

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

/**
 * An entry whose unit matches the exact shape `buildAgentScopeInvocation`
 * generates, so it is a legitimate signalling target.
 */
function buildSignalableEntry(overrides: Partial<AgentProcessEntry> = {}): AgentProcessEntry {
  return buildEntry({
    scopeId: "paseo-agent-4242-aaaaaaaaaaaa",
    unit: "paseo-agent-4242-aaaaaaaaaaaa.scope",
    ...overrides,
  });
}

/** As `buildSignalableEntry`, with an orphan window that has already elapsed. */
function buildExpiredOrphanEntry(overrides: Partial<AgentProcessEntry> = {}): AgentProcessEntry {
  return {
    ...buildSignalableEntry({
      orphanedAt: new Date(Date.now() - AGENT_PROCESS_UNOWNED_RECORD_TTL_MS - 60_000).toISOString(),
    }),
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

  test("recovers from a corrupt registry file without erasing the corrupt content", () => {
    writeFileSync(filePath, "{ this is not json !!");
    expect(readAgentProcessRegistry({ filePath, logger })).toEqual([]);

    // A successful record starts clean, but the corrupt bytes are moved aside
    // rather than overwritten, so an operator can still inspect them.
    expect(recordAgentProcess(buildEntry({ pid: 7 }), { filePath, logger })).toBe(true);
    expect(readAgentProcessRegistry({ filePath })).toHaveLength(1);
    const quarantined = readdirSync(tmpDir).filter((name) => name.includes(".corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(path.join(tmpDir, quarantined[0]), "utf8")).toBe("{ this is not json !!");

    // Wrong shape counts as corrupt too, and is quarantined the same way.
    writeFileSync(filePath, JSON.stringify({ pid: 1 }));
    expect(readAgentProcessRegistry({ filePath, logger })).toEqual([]);
    expect(readdirSync(tmpDir).filter((name) => name.includes(".corrupt-"))).toHaveLength(2);

    // A reaper on a corrupt file degrades to an empty result, then rewrites cleanly.
    const result = reapStaleAgentProcesses({ filePath, logger });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(recordAgentProcess(buildEntry({ pid: 9 }), { filePath, logger })).toBe(true);
    expect(readAgentProcessRegistry({ filePath })).toHaveLength(1);
  });

  test("refuses to write when the registry is present but unreadable", () => {
    // A directory at the registry path makes every read fail with EISDIR. This
    // is the class of failure that used to be reported as "empty registry",
    // which made recordAgentProcess write back a single-entry file and erase
    // every other live child's record.
    mkdirSync(filePath, { recursive: true });

    expect(recordAgentProcess(buildEntry(), { filePath, logger })).toBe(false);
    expect(forgetAgentProcess(4242, { filePath, logger })).toBe(false);
    expect(reapStaleAgentProcesses({ filePath, logger })).toEqual({ removed: [], kept: [] });
    expect(flushLiveAgentProcesses({ filePath, logger })).toEqual({ kept: [], removed: [] });
    // Nothing was replaced: the unreadable path is left exactly as found.
    expect(statSync(filePath).isDirectory()).toBe(true);
    rmSync(filePath, { recursive: true, force: true });
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

  // Review finding #42-B1. The previous version of this test asserted the
  // opposite of the fix: it reaped an expired unowned record and then asserted
  // the child was STILL ALIVE. That encoded the defect — dropping the record
  // while the process lives leaves it running and now untracked, so nothing can
  // ever kill it again. The reap must now stop the orphan first and only then
  // drop its record.
  test("stops an expired orphan and drops its record only after the process is gone", async () => {
    const logs: string[] = [];
    const captureLogger = pino({ level: "warn" }, { write: (line) => logs.push(line) });
    const probe = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(probe);

    recordAgentProcess(
      buildExpiredOrphanEntry({
        pid: probe.pid,
        ownerDaemonId: "previous-daemon-generation",
      }),
      { filePath, logger: captureLogger },
    );

    const killed: Array<{ unit: string; signal: string }> = [];
    const result = reapStaleAgentProcesses({
      filePath,
      logger: captureLogger,
      killScope: (unit, signal) => {
        killed.push({ unit, signal });
        // Real SIGKILL so the probe is genuinely stopped; the reaper's
        // post-kill check treats the resulting zombie as gone.
        process.kill(probe.pid, "SIGKILL");
      },
      sleepMs: () => {},
    });

    // Signalled as a unit, never by pid: SIGTERM first, SIGKILL only if needed.
    expect(killed.length).toBeGreaterThanOrEqual(1);
    expect(killed[0]).toEqual({
      unit: `paseo-agent-4242-${"a".repeat(12)}.scope`,
      signal: "SIGTERM",
    });

    expect(result.removed.map((entry) => entry.pid)).toEqual([probe.pid]);
    expect(result.kept).toEqual([]);
    expect(readAgentProcessRegistry({ filePath })).toEqual([]);

    // The child really is stopped, and the log names the scope it stopped.
    // isPidRunning (not isPidAlive) because a SIGKILLed child of this test
    // process lingers as a zombie until the event loop reaps it — and a zombie
    // is stopped: no memory, no fds, no CPU, and it will never run again.
    expect(isPidRunning(probe.pid), "the expired orphan is stopped").toBe(false);
    const warning = logs.find((line) => line.includes("Stopped expired orphan agent scope"));
    expect(warning, "reaper logs the stopped orphan by scope").toBeTruthy();
    expect(warning).toContain(`paseo-agent-4242-${"a".repeat(12)}.scope`);
  });

  test("keeps the record when the orphan survives the kill so the next reap retries", async () => {
    const logs: string[] = [];
    const captureLogger = pino({ level: "warn" }, { write: (line) => logs.push(line) });
    const probe = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(probe);

    recordAgentProcess(
      buildExpiredOrphanEntry({
        pid: probe.pid,
        ownerDaemonId: "previous-daemon-generation",
      }),
      { filePath, logger: captureLogger },
    );

    let signals = 0;
    const result = reapStaleAgentProcesses({
      filePath,
      logger: captureLogger,
      // Nothing actually stops: the record must survive for the next reap.
      killScope: () => {
        signals += 1;
      },
      sleepMs: () => {},
      termGraceMs: 0,
      killTimeoutMs: 0,
    });

    expect(signals).toBeGreaterThanOrEqual(1);
    expect(result.removed).toEqual([]);
    expect(result.kept.map((entry) => entry.pid)).toEqual([probe.pid]);
    expect(readAgentProcessRegistry({ filePath }).map((entry) => entry.pid)).toEqual([probe.pid]);
    expectPidAlive(probe.pid, "the unkillable orphan is still running");

    const error = logs.find((line) => line.includes("Failed to stop expired agent scope orphan"));
    expect(error, "a kill failure is logged loudly, not swallowed").toBeTruthy();
    expect(error).toContain("orphan-kill-failed");
  });

  test("refuses to signal a tampered unit name and keeps the record", async () => {
    const logs: string[] = [];
    const captureLogger = pino({ level: "warn" }, { write: (line) => logs.push(line) });
    const probe = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(probe);

    // `$PASEO_HOME/agent-processes.json` is data, and the unit name in it is
    // handed to `systemctl --user kill`. A tampered entry must not be able to
    // make the reaper terminate an arbitrary user unit.
    const tamperedUnits = [
      "sshd.service",
      "paseo.service",
      "paseo-agent-4242-zzzzzzzzzzzz.scope",
      "paseo-agent-4242-aaaaaaaaaaaa.scope.evil",
      "paseo-agent-4242-aaaaaaaaaaaa.scope extra",
      "",
    ];
    for (const unit of tamperedUnits) {
      const entry = buildExpiredOrphanEntry({
        pid: probe.pid,
        ownerDaemonId: "previous-daemon-generation",
      });
      expect(isSignalableAgentScopeUnit({ ...entry, unit })).toBe(false);
    }

    // End to end through the reaper: nothing is signalled, record is kept.
    recordAgentProcess(
      {
        ...buildExpiredOrphanEntry({
          pid: probe.pid,
          ownerDaemonId: "previous-daemon-generation",
        }),
        unit: "sshd.service",
      },
      { filePath, logger: captureLogger },
    );

    let killCalls = 0;
    const result = reapStaleAgentProcesses({
      filePath,
      logger: captureLogger,
      killScope: () => {
        killCalls += 1;
      },
      sleepMs: () => {},
    });

    expect(killCalls).toBe(0);
    expect(result.removed).toEqual([]);
    expect(result.kept.map((entry) => entry.unit)).toEqual(["sshd.service"]);
    expect(readAgentProcessRegistry({ filePath })).toHaveLength(1);
    expectPidAlive(probe.pid, "the untrusted entry's process is untouched");

    const error = logs.find((line) => line.includes("not a scope unit this daemon created"));
    expect(error, "an untrusted unit name is refused loudly").toBeTruthy();
    expect(error).toContain("untrusted-unit-name");
  });

  test("never signals a live record this daemon owns", async () => {
    const probe = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(probe);
    // Expired on paper, but owned by this daemon generation: a legitimately
    // long-lived agent must never be reaped out from under its owner.
    recordAgentProcess(
      buildExpiredOrphanEntry({
        pid: probe.pid,
        startedAt: new Date(
          Date.now() - AGENT_PROCESS_UNOWNED_RECORD_TTL_MS - 60_000,
        ).toISOString(),
      }),
      { filePath, logger },
    );
    expect(readAgentProcessRegistry({ filePath })[0].ownerDaemonId).toBe(
      getAgentProcessOwnerDaemonId(),
    );

    let killCalls = 0;
    const result = reapStaleAgentProcesses({
      filePath,
      logger,
      killScope: () => {
        killCalls += 1;
      },
      sleepMs: () => {},
    });

    expect(killCalls).toBe(0);
    expect(result.removed).toEqual([]);
    expect(result.kept.map((entry) => entry.pid)).toEqual([probe.pid]);
    expectPidAlive(probe.pid, "this daemon's own agent is never signalled");
  });

  test("stamps orphanedAt on first sight and expires from it, not from startedAt", async () => {
    const probe = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(probe);
    const longStartedAt = new Date(
      Date.now() - AGENT_PROCESS_UNOWNED_RECORD_TTL_MS - 60_000,
    ).toISOString();
    // No orphanedAt yet: this is the first daemon to see the entry unowned.
    recordAgentProcess(
      buildSignalableEntry({
        pid: probe.pid,
        ownerDaemonId: "previous-daemon-generation",
        startedAt: longStartedAt,
      }),
      { filePath, logger },
    );

    // First reap after the owner died: the orphan clock starts NOW. A
    // long-running agent must not lose its record just because it is old.
    const first = reapStaleAgentProcesses({ filePath, logger });
    expect(first.removed).toEqual([]);
    expect(first.kept.map((entry) => entry.pid)).toEqual([probe.pid]);
    const stamped = readAgentProcessRegistry({ filePath })[0];
    expect(stamped.orphanedAt).toBeTruthy();
    expect(new Date(stamped.orphanedAt as string).getTime()).toBeGreaterThan(
      new Date(longStartedAt).getTime(),
    );

    // A second reap keeps the first stamp: the window must not slide forward.
    const second = reapStaleAgentProcesses({ filePath, logger });
    expect(second.removed).toEqual([]);
    expect(readAgentProcessRegistry({ filePath })[0].orphanedAt).toBe(stamped.orphanedAt);
    expectPidAlive(probe.pid, "the orphan survives inside its adoption window");

    // Only once the window has genuinely elapsed is it stopped.
    const expired = readAgentProcessRegistry({ filePath })[0];
    recordAgentProcess(
      {
        ...expired,
        orphanedAt: new Date(Date.now() - AGENT_PROCESS_UNOWNED_RECORD_TTL_MS - 1).toISOString(),
      },
      { filePath, logger },
    );
    const third = reapStaleAgentProcesses({
      filePath,
      logger,
      killScope: () => {},
      sleepMs: () => {},
      termGraceMs: 0,
      killTimeoutMs: 0,
    });
    expect(third.removed).toEqual([]);
    expect(third.kept.map((entry) => entry.pid)).toEqual([probe.pid]);
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

// Real-systemd proof of the #42-B1 kill path. `systemctl --user stop` is a
// no-op for scope units (verified on systemd 259: exits 0, process keeps
// running), so this exercises the primitive that actually stops one:
// `systemctl --user kill --kill-whom=all`. Skipped where there is no real
// systemd user session — it is NOT a CI gate on such runners.
describe.skipIf(process.platform !== "linux")("expired orphan stop (real systemd)", () => {
  let tmpDir: string;
  let filePath: string;
  let spawnedChild: ReturnType<typeof spawn> | null = null;
  let canScope = false;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-process-orphan-kill-"));
    filePath = path.join(tmpDir, "agent-processes.json");
    canScope = probeAgentScopeRoundTrip().ok;
  });

  afterEach(() => {
    if (spawnedChild && spawnedChild.exitCode === null && spawnedChild.signalCode === null) {
      spawnedChild.kill("SIGKILL");
    }
    spawnedChild = null;
    __setAgentProcessScopeDetectionForTests(null);
    __setAgentProcessScopeProbeForTests(null);
    setAgentProcessRegistryHome(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test.runIf(process.platform === "linux")(
    "stops a real scoped orphan and only then drops its record",
    async () => {
      if (!canScope) {
        // No systemd user session here (typical CI runner): say so out loud
        // instead of pretending the real kill path was exercised.
        console.warn(
          "[agent-process-registry] real systemd scope unavailable; orphan kill e2e skipped",
        );
        return;
      }
      setAgentProcessRegistryHome(tmpDir);
      __setAgentProcessScopeDetectionForTests({ available: true, reason: "forced by test" });
      __setAgentProcessScopeProbeForTests(() => ({ ok: true, reason: "forced by test" }));

      spawnedChild = spawnInAgentScope(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore" },
        { provider: "orphan-kill-test", logger },
      );
      const pid = spawnedChild.pid;
      expect(typeof pid).toBe("number");

      const recorded = readAgentProcessRegistry({ filePath, logger });
      expect(recorded).toHaveLength(1);
      expect(isSignalableAgentScopeUnit(recorded[0])).toBe(true);

      // systemd-run execs the target into the scope asynchronously; wait for the
      // real cgroup membership instead of assuming it exists at spawn time.
      await expect
        .poll(() => classifyAgentProcessEntry(readAgentProcessRegistry({ filePath, logger })[0]), {
          timeout: 10_000,
          interval: 100,
        })
        .toBe("live-matching");

      // Age the entry into an orphan from a previous daemon generation.
      recordAgentProcess(
        {
          ...readAgentProcessRegistry({ filePath, logger })[0],
          ownerDaemonId: "previous-daemon-generation",
          orphanedAt: new Date(
            Date.now() - AGENT_PROCESS_UNOWNED_RECORD_TTL_MS - 60_000,
          ).toISOString(),
        },
        { filePath, logger },
      );
      expect(classifyAgentProcessEntry(readAgentProcessRegistry({ filePath, logger })[0])).toBe(
        "live-matching",
      );

      // No killScope seam: this drives the real systemctl path.
      const result = reapStaleAgentProcesses({ filePath, logger });

      expect(result.removed.map((entry) => entry.pid)).toEqual([pid]);
      expect(readAgentProcessRegistry({ filePath, logger })).toEqual([]);
      expect(isPidRunning(pid as number), "the real scoped orphan is stopped").toBe(false);
    },
  );
});
