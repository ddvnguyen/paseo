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
  isPidAlive,
  isPidRunning,
  isPidZombie,
  isSignalableAgentScopeUnit,
  readAgentProcessRegistry,
  readAgentScopePopulation,
  recordAgentProcess,
  reapStaleAgentProcesses,
  resolveAgentProcessRegistryPath,
  setAgentProcessRegistryHome,
  type AgentProcessEntry,
  type AgentScopePopulation,
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

// ---------------------------------------------------------------------------
// Real unreaped children ("zombies").
//
// libuv — and every Node parent — reaps the processes it spawns BEFORE it emits
// `exit`, so no test running inside this process can ever observe a pid in state
// `Z`. That is exactly why driving a synthetic `exit` event cannot reproduce the
// defect these fixtures exist for: the defect needs a pid that answers
// `kill(pid, 0)` while `/proc/<pid>/cmdline` is empty, and only a process whose
// parent declines to `waitpid` produces that pair.
//
// The launcher below forks a SIGTERM-ignoring heartbeat writer (the survivor —
// the stand-in for the dev server an ACP adapter leaves behind), then forks a
// second child that calls `os._exit(0)`, publishes both pids, and then sleeps
// WITHOUT ever reaping. Staying alive is what stops the unreaped child being
// reparented to init and collected, so the zombie is genuinely present for the
// whole test rather than for one lucky poll.
// ---------------------------------------------------------------------------

const ZOMBIE_LAUNCHER_SOURCE = `
import os, signal, sys, time

zombie_pid_file, member_pid_file, ready_file, beat_file = sys.argv[1:5]
hold_seconds = float(sys.argv[5])

# The survivor. Ignoring SIGTERM and beating keeps "present" distinguishable from
# "still running", and a heartbeat also survives pid reuse.
signal.signal(signal.SIGTERM, signal.SIG_IGN)
if os.fork() == 0:
    with open(member_pid_file, "w") as handle:
        handle.write(str(os.getpid()))
    while True:
        with open(beat_file, "w") as handle:
            handle.write(str(time.time()))
        time.sleep(0.1)

# The recorded main pid: exits at once, and this launcher never calls waitpid on
# it, so it stays in state Z with an empty /proc/<pid>/cmdline.
zombie = os.fork()
if zombie == 0:
    os._exit(0)

with open(zombie_pid_file, "w") as handle:
    handle.write(str(zombie))
with open(ready_file, "w") as handle:
    handle.write(str(os.getpid()))

time.sleep(hold_seconds)
`;

/** How long the launcher holds its unreaped child. Longer than any assertion. */
const ZOMBIE_HOLD_SECONDS = 120;

interface ZombieFixturePaths {
  script: string;
  zombiePidFile: string;
  memberPidFile: string;
  readyFile: string;
  beatFile: string;
}

interface ZombieFixture extends ZombieFixturePaths {
  launcherPid: number;
  zombiePid: number;
  memberPid: number;
}

let zombieLauncherCommand: string | null | undefined;

/** The interpreter that produces the real zombie, or null when the host has none. */
function resolveZombieLauncherCommand(): string | null {
  if (zombieLauncherCommand === undefined) {
    zombieLauncherCommand =
      spawnSync("python3", ["-c", "pass"], { stdio: "ignore" }).status === 0 ? "python3" : null;
  }
  return zombieLauncherCommand;
}

/**
 * Skip loudly rather than pretending the real zombie path ran. A host with no
 * python3 cannot produce an unreaped child at all, and a quiet skip would let a
 * green run hide the fact that the defect's real trigger was never built.
 */
function requireZombieLauncher(): boolean {
  if (resolveZombieLauncherCommand() !== null) return true;
  const message = "[agent-process-registry] python3 unavailable; real-zombie tests skipped";
  if (process.env.PASEO_REQUIRE_SYSTEMD_TESTS === "1") {
    throw new Error(message);
  }
  console.warn(message);
  return false;
}

function writeZombieLauncher(tmpDir: string): ZombieFixturePaths {
  const script = path.join(tmpDir, "zombie-launcher.py");
  writeFileSync(script, ZOMBIE_LAUNCHER_SOURCE);
  return {
    script,
    zombiePidFile: path.join(tmpDir, "zombie.pid"),
    memberPidFile: path.join(tmpDir, "member.pid"),
    readyFile: path.join(tmpDir, "launcher.ready"),
    beatFile: path.join(tmpDir, "member.beat"),
  };
}

/** Spawn the launcher, optionally inside a real `KillMode=process` scope. */
function spawnZombieLauncher(
  paths: ZombieFixturePaths,
  children: ReturnType<typeof spawn>[],
  options: { scoped: boolean },
): number {
  const command = resolveZombieLauncherCommand();
  if (command === null) throw new Error("requireZombieLauncher() must gate this call");
  const args = [
    paths.script,
    paths.zombiePidFile,
    paths.memberPidFile,
    paths.readyFile,
    paths.beatFile,
    String(ZOMBIE_HOLD_SECONDS),
  ];
  const child = options.scoped
    ? spawnInAgentScope(command, args, { stdio: "ignore" }, { provider: "zombie-fixture", logger })
    : spawn(command, args, { stdio: "ignore" });
  children.push(child);
  if (typeof child.pid !== "number") {
    throw new Error("failed to spawn the zombie launcher");
  }
  return child.pid;
}

/**
 * Wait for the launcher to publish all three files, then hand back the fixture.
 * Polled rather than raced: the zombie only exists once its parent has forked it
 * and declined to reap it.
 */
async function waitForZombieFixture(
  paths: ZombieFixturePaths,
  launcherPid: number,
): Promise<ZombieFixture> {
  await expect
    .poll(
      () =>
        existsSync(paths.zombiePidFile) &&
        existsSync(paths.memberPidFile) &&
        existsSync(paths.readyFile),
      { timeout: 15_000, interval: 25 },
    )
    .toBe(true);
  return {
    ...paths,
    launcherPid,
    zombiePid: Number(readFileSync(paths.zombiePidFile, "utf8")),
    memberPid: Number(readFileSync(paths.memberPidFile, "utf8")),
  };
}

/**
 * Assert the recorded pid really is an unreaped child BEFORE anything is
 * concluded from its classification: state `Z`, an empty `/proc/<pid>/cmdline`,
 * and `kill(pid, 0)` still succeeding. Without all three the test could pass for
 * the wrong reason — a reaped-then-reused pid answers `kill(pid, 0)` too.
 */
function expectRealZombie(pid: number): void {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // "pid (comm) state ..." — comm can contain spaces and parentheses, so the
  // state letter is the first token after the final ')'.
  const state = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/)[0];
  expect(state, `pid ${pid} must be an unreaped child in state Z`).toBe("Z");
  expect(readFileSync(`/proc/${pid}/cmdline`, "utf8"), "a zombie has an empty cmdline").toBe("");
  expect(isPidAlive(pid), "a zombie still answers kill(pid, 0)").toBe(true);
  expect(isPidZombie(pid), "isPidZombie must observe the same state").toBe(true);
  expect(isPidRunning(pid), "a zombie can no longer consume CPU").toBe(false);
}

/** SIGKILL every pid a fixture created; a no-op for pids already gone. */
function killPids(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
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
  test("stops an expired orphan and drops its record only after the scope is empty", async () => {
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
      // The probe is not really in a systemd scope, so its "scope" population
      // is modelled on its own liveness. This is what the fix reads, and the
      // post-kill check only passes because the SIGKILL above emptied it.
      readScopePopulation: () =>
        isPidRunning(probe.pid)
          ? { known: true, populated: true, pids: [probe.pid] }
          : { known: true, populated: false, pids: [] },
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
      readScopePopulation: () => ({ known: true, populated: true, pids: [probe.pid] }),
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
      // The probe is not in a real systemd scope, so model the scope as still
      // populated: that is the state the kill path has to see before it tries,
      // and it is what keeps the record once the kill achieves nothing.
      readScopePopulation: () => ({ known: true, populated: true, pids: [probe.pid] }),
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
  // The zombie fixture's launcher forks a member that outlives it, so the
  // launcher being killed is not enough to clean the fixture up.
  const fixturePids: number[] = [];

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
    // Unconditional, and in this order: the member and the zombie are
    // grandchildren the launcher spawned, so killing the launcher reaps the
    // zombie but leaves the member running.
    killPids(fixturePids.splice(0));
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

  // ---------------------------------------------------------------------------
  // The blocking defect: a record was deleted while processes in its scope were
  // still alive, because every liveness check read `entry.pid` and never the
  // scope's cgroup. Each test below is paired with a single-site mutation in the
  // PR description, so it is provably capable of failing.
  // ---------------------------------------------------------------------------

  test("classifies a dead main pid as live-matching while its scope still has members", async () => {
    const survivor = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(survivor);
    // A pid that is definitely gone: a synchronous child that already exited and
    // was reaped, so `kill(pid, 0)` fails.
    const gonePid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;
    expect(isPidAlive(gonePid)).toBe(false);

    const entry = buildSignalableEntry({ pid: gonePid });
    // The scope the entry names still holds `survivor`, even though the recorded
    // main pid is gone. Pinning the exact value matters: anything other than
    // "live-matching" is dropped by the reaper without a signal.
    expect(
      classifyAgentProcessEntry(entry, () => ({
        known: true,
        populated: true,
        pids: [survivor.pid],
      })),
    ).toBe("live-matching");

    // An empty scope is the only thing that makes a dead pid "dead".
    expect(
      classifyAgentProcessEntry(entry, () => ({ known: true, populated: false, pids: [] })),
    ).toBe("dead");
  });

  test("does not consult the scope when the pid path already classifies the entry", async () => {
    // Perf guard: a reap of live records must not fork a `systemctl show` per
    // entry, so the scope is only read once the pid path is inconclusive.
    const probe = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(probe);
    let scopeReads = 0;
    const counting = (): AgentScopePopulation => {
      scopeReads += 1;
      return { known: true, populated: false, pids: [] };
    };

    expect(classifyAgentProcessEntry(buildEntry({ pid: probe.pid }), counting)).toBe(
      "live-matching",
    );
    expect(scopeReads, "a live pid must not cost a scope read").toBe(0);

    const gonePid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;
    expect(classifyAgentProcessEntry(buildEntry({ pid: gonePid }), counting)).toBe("dead");
    expect(scopeReads, "an inconclusive pid must consult the scope exactly once").toBe(1);
  });

  // ---------------------------------------------------------------------------
  // `!isPidAlive` is not the only way for the pid path to be inconclusive. A pid
  // can answer `kill(pid, 0)` and still carry NO usable identity: a zombie has
  // already exited, so `/proc/<pid>/cmdline` is empty. The code returned "dead"
  // there without ever asking the scope, and the reaper deleted the record with
  // the survivor still running — the exact outcome this whole path exists to
  // prevent.
  //
  // Driven by a REAL unreaped child. A synthetic `exit` event cannot produce
  // this state: libuv reaps a child before emitting `exit`, so the pid is always
  // already gone by then, which is why the earlier round of probes passed on the
  // buggy code.
  // ---------------------------------------------------------------------------

  test("classifies a real zombie main pid as live-matching while its scope still has members", async () => {
    if (!requireZombieLauncher()) return;
    const paths = writeZombieLauncher(tmpDir);
    const launcherPid = spawnZombieLauncher(paths, liveChildren, { scoped: false });
    const fixture = await waitForZombieFixture(paths, launcherPid);
    fixturePids.push(fixture.launcherPid, fixture.zombiePid, fixture.memberPid);

    // The precondition, asserted before anything is concluded from it.
    expectRealZombie(fixture.zombiePid);
    expect(isPidRunning(fixture.memberPid), "the survivor is a real running process").toBe(true);

    const entry = buildSignalableEntry({ pid: fixture.zombiePid, provider: "claude-acp" });
    const populatedScope = (): AgentScopePopulation => ({
      known: true,
      populated: true,
      pids: [fixture.memberPid],
    });

    // Pinning the exact value matters: anything else is dropped by the reaper
    // without a signal.
    expect(classifyAgentProcessEntry(entry, populatedScope)).toBe("live-matching");

    // And through the reaper end to end: the record survives the zombie main pid.
    recordAgentProcess(entry, { filePath, logger });
    const result = reapStaleAgentProcesses({
      filePath,
      logger,
      readScopePopulation: populatedScope,
      sleepMs: () => {},
    });
    expect(result.removed).toEqual([]);
    expect(result.kept.map((kept) => kept.pid)).toEqual([fixture.zombiePid]);
    expect(readAgentProcessRegistry({ filePath }).map((kept) => kept.pid)).toEqual([
      fixture.zombiePid,
    ]);
    expect(isPidRunning(fixture.memberPid), "the survivor is untouched").toBe(true);

    // The detach-stop flush decides from the pid alone, and a zombie answers
    // `kill(pid, 0)`, so it must keep the record too. Asserted so a future change
    // to `isPidAlive` cannot quietly reintroduce the same leak here.
    const flushed = flushLiveAgentProcesses({
      filePath,
      logger,
      readScopePopulation: populatedScope,
    });
    expect(flushed.removed).toEqual([]);
    expect(flushed.kept.map((kept) => kept.pid)).toEqual([fixture.zombiePid]);
  });

  test("classifies a real zombie main pid as dead only when its scope is provably empty", async () => {
    if (!requireZombieLauncher()) return;
    const paths = writeZombieLauncher(tmpDir);
    const launcherPid = spawnZombieLauncher(paths, liveChildren, { scoped: false });
    const fixture = await waitForZombieFixture(paths, launcherPid);
    fixturePids.push(fixture.launcherPid, fixture.zombiePid, fixture.memberPid);
    expectRealZombie(fixture.zombiePid);

    const entry = buildSignalableEntry({ pid: fixture.zombiePid, provider: "claude-acp" });

    // The symmetric case on the SAME real zombie: the scope decides, not the pid.
    // A zombie alone must not keep a record alive forever.
    expect(
      classifyAgentProcessEntry(entry, () => ({ known: true, populated: false, pids: [] })),
    ).toBe("dead");

    // An unmeasurable scope is "cannot tell", never "empty" — even when the
    // reading claims it is empty, which is the one combination that would let an
    // unreadable cgroup delete a live record.
    expect(
      classifyAgentProcessEntry(entry, () => ({
        known: false,
        populated: false,
        pids: [],
        reason: "simulated",
      })),
    ).toBe("live-matching");
  });

  test("still classifies a genuinely dead pid with an empty scope as dead", async () => {
    // The guard on the other side of the fix: routing inconclusive pids through
    // the scope must not make records immortal. A reaped-and-gone pid in a
    // provably empty scope is still `dead`, and is still dropped.
    const gonePid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;
    expect(isPidAlive(gonePid)).toBe(false);
    const emptyScope = (): AgentScopePopulation => ({ known: true, populated: false, pids: [] });
    const entry = buildSignalableEntry({ pid: gonePid });

    expect(classifyAgentProcessEntry(entry, emptyScope)).toBe("dead");

    recordAgentProcess(entry, { filePath, logger });
    const result = reapStaleAgentProcesses({
      filePath,
      logger,
      readScopePopulation: emptyScope,
      sleepMs: () => {},
    });
    expect(result.removed.map((removed) => removed.pid)).toEqual([gonePid]);
    expect(readAgentProcessRegistry({ filePath })).toEqual([]);
  });

  test("consults the scope exactly once for a real zombie main pid", async () => {
    // Perf guard extended to the new inconclusive branch: a zombie costs ONE
    // scope read, and a pid that classifies outright still costs none — so
    // reaping live records keeps costing no `systemctl` fork per entry.
    if (!requireZombieLauncher()) return;
    const paths = writeZombieLauncher(tmpDir);
    const launcherPid = spawnZombieLauncher(paths, liveChildren, { scoped: false });
    const fixture = await waitForZombieFixture(paths, launcherPid);
    fixturePids.push(fixture.launcherPid, fixture.zombiePid, fixture.memberPid);
    expectRealZombie(fixture.zombiePid);

    let scopeReads = 0;
    const counting = (): AgentScopePopulation => {
      scopeReads += 1;
      return { known: true, populated: true, pids: [fixture.memberPid] };
    };
    const entry = buildSignalableEntry({ pid: fixture.zombiePid });
    expect(classifyAgentProcessEntry(entry, counting)).toBe("live-matching");
    expect(scopeReads, "an inconclusive pid must consult the scope exactly once").toBe(1);

    // And the same entry against a pid that classifies outright still costs none.
    const liveProbe = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(liveProbe);
    expect(classifyAgentProcessEntry(buildEntry({ pid: liveProbe.pid }), counting)).toBe(
      "live-matching",
    );
    expect(scopeReads, "a live pid must not cost a scope read").toBe(1);
  });

  test("keeps a record whose scope population cannot be read", async () => {
    const gonePid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;
    expect(isPidAlive(gonePid)).toBe(false);

    const logs: string[] = [];
    const captureLogger = pino({ level: "warn" }, { write: (line) => logs.push(line) });
    // systemd is unreachable: no user bus, systemctl missing. "Cannot tell" must
    // never be read as "empty" — the record is the only handle on whatever is
    // still running in that scope.
    const unreadable = (): AgentScopePopulation => ({
      known: false,
      populated: true,
      pids: [],
      reason: "systemctl show failed: simulated",
    });

    recordAgentProcess(buildEntry({ scopeId: "gone-1", unit: "gone-1.scope", pid: gonePid }), {
      filePath,
      logger: captureLogger,
    });
    const reaped = reapStaleAgentProcesses({
      filePath,
      logger: captureLogger,
      readScopePopulation: unreadable,
      sleepMs: () => {},
    });
    expect(reaped.removed).toEqual([]);
    expect(reaped.kept.map((entry) => entry.pid)).toEqual([gonePid]);

    // The detach-stop flush must apply the same rule.
    const flushed = flushLiveAgentProcesses({
      filePath,
      logger: captureLogger,
      readScopePopulation: unreadable,
    });
    expect(flushed.removed).toEqual([]);
    expect(flushed.kept.map((entry) => entry.pid)).toEqual([gonePid]);
    expect(readAgentProcessRegistry({ filePath })).toHaveLength(1);

    // Nothing was ever signalled for a scope nobody could measure.
    expect(
      logs.some((line) => line.includes("Systemctl") || line.includes("systemctl --user kill")),
      "an unreadable scope must not fall through to a signal",
    ).toBe(false);
  });

  test("reports an unreadable scope loudly once the orphan window has elapsed", async () => {
    const gonePid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;
    const logs: string[] = [];
    const captureLogger = pino({ level: "warn" }, { write: (line) => logs.push(line) });

    recordAgentProcess(
      buildExpiredOrphanEntry({ pid: gonePid, ownerDaemonId: "previous-daemon-generation" }),
      { filePath, logger: captureLogger },
    );
    const result = reapStaleAgentProcesses({
      filePath,
      logger: captureLogger,
      readScopePopulation: () => ({
        known: false,
        populated: true,
        pids: [],
        reason: "systemctl show failed: simulated",
      }),
      sleepMs: () => {},
    });

    expect(result.removed).toEqual([]);
    expect(result.kept.map((entry) => entry.pid)).toEqual([gonePid]);
    // Kept, but not silently: the operator has to be able to see why.
    const error = logs.find((line) => line.includes("orphan-kill-failed"));
    expect(error, "an unmeasurable scope is reported as a failed stop").toBeTruthy();
    expect(error).toContain("scope population unreadable");
  });

  test("keeps a record and signals the scope when the main pid is dead but the cgroup has members", async () => {
    // The highest-value test in this file: it pins BOTH pid-only sites at once.
    //  - `classifyAgentProcessEntry` used to answer "dead" for a gone main pid
    //    and the reaper dropped the record with zero signals.
    //  - `stopExpiredAgentScope` used to answer "already gone" for a gone main
    //    pid and the reaper dropped the record after zero signals.
    const survivor = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(survivor);
    const gonePid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;
    expect(isPidAlive(gonePid)).toBe(false);

    recordAgentProcess(
      buildExpiredOrphanEntry({ pid: gonePid, ownerDaemonId: "previous-daemon-generation" }),
      { filePath, logger },
    );

    const signals: string[] = [];
    const result = reapStaleAgentProcesses({
      filePath,
      logger,
      // A kill that achieves nothing: the record must survive, and the scope
      // must have been signalled rather than dismissed on the pid alone.
      killScope: (unit, signal) => {
        signals.push(signal);
        expect(unit).toBe(`paseo-agent-4242-${"a".repeat(12)}.scope`);
      },
      readScopePopulation: () => ({ known: true, populated: true, pids: [survivor.pid] }),
      sleepMs: () => {},
      termGraceMs: 0,
      killTimeoutMs: 0,
    });

    expect(signals.length, "a live scope member must be signalled").toBeGreaterThanOrEqual(1);
    expect(signals[0]).toBe("SIGTERM");
    expect(result.removed).toEqual([]);
    expect(result.kept.map((entry) => entry.pid)).toEqual([gonePid]);
    expect(readAgentProcessRegistry({ filePath }).map((entry) => entry.pid)).toEqual([gonePid]);
    expectPidAlive(survivor.pid, "the survivor the record exists for is untouched");
  });

  test("escalates to SIGKILL when the scope still has members after SIGTERM", async () => {
    const survivor = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(survivor);
    const gonePid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;

    recordAgentProcess(
      buildExpiredOrphanEntry({ pid: gonePid, ownerDaemonId: "previous-daemon-generation" }),
      { filePath, logger },
    );

    const signals: string[] = [];
    // A member that ignores SIGTERM: it is still there after the grace period,
    // so the fix must escalate rather than report success.
    const result = reapStaleAgentProcesses({
      filePath,
      logger,
      killScope: (_unit, signal) => {
        signals.push(signal);
      },
      readScopePopulation: () => ({ known: true, populated: true, pids: [survivor.pid] }),
      sleepMs: () => {},
      termGraceMs: 0,
      killTimeoutMs: 0,
    });

    expect(signals).toContain("SIGTERM");
    expect(signals, "a surviving member must be escalated to SIGKILL").toContain("SIGKILL");
    // Only once the scope is actually empty may the record go; it never is here.
    expect(result.removed).toEqual([]);
    expect(readAgentProcessRegistry({ filePath })).toHaveLength(1);
    expectPidAlive(survivor.pid, "a SIGTERM-ignoring member survives the failed escalation");
  });

  test("drops the record once the scope empties, not before", async () => {
    const survivor = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(survivor);
    const gonePid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;

    recordAgentProcess(
      buildExpiredOrphanEntry({ pid: gonePid, ownerDaemonId: "previous-daemon-generation" }),
      { filePath, logger },
    );

    // The kill only empties the scope at SIGKILL, not at SIGTERM.
    let stillPopulated = true;
    const signals: string[] = [];
    const result = reapStaleAgentProcesses({
      filePath,
      logger,
      killScope: (_unit, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") stillPopulated = false;
      },
      readScopePopulation: () =>
        stillPopulated
          ? { known: true, populated: true, pids: [survivor.pid] }
          : { known: true, populated: false, pids: [] },
      sleepMs: () => {},
      termGraceMs: 0,
      killTimeoutMs: 0,
    });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.removed.map((entry) => entry.pid)).toEqual([gonePid]);
    expect(readAgentProcessRegistry({ filePath })).toEqual([]);
  });

  test("never signals an entry whose unit name is untrusted, and keeps it while its scope reads populated", async () => {
    const survivor = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(survivor);
    const gonePid = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" }).pid as number;

    // A tampered unit name is never a signalling target, whatever the scope
    // reader says. It must also not be dropped on the strength of a population
    // reading, because an untrusted name cannot be resolved to a cgroup we own.
    recordAgentProcess(
      {
        ...buildExpiredOrphanEntry({ pid: gonePid, ownerDaemonId: "previous-daemon-generation" }),
        unit: "sshd.service",
      },
      { filePath, logger },
    );
    let killCalls = 0;
    const result = reapStaleAgentProcesses({
      filePath,
      logger,
      killScope: () => {
        killCalls += 1;
      },
      readScopePopulation: () => ({ known: true, populated: true, pids: [survivor.pid] }),
      sleepMs: () => {},
      termGraceMs: 0,
      killTimeoutMs: 0,
    });
    expect(killCalls, "an untrusted unit name never authorises a signal").toBe(0);
    expect(result.removed).toEqual([]);
    expect(result.kept.map((entry) => entry.pid)).toEqual([gonePid]);
    expectPidAlive(survivor.pid, "an untrusted entry never authorises a signal");

    // With the REAL reader an untrusted name resolves to no cgroup at all, so it
    // is dropped on pid liveness alone and still never signalled.
    const dropped = reapStaleAgentProcesses({ filePath, logger, sleepMs: () => {} });
    expect(dropped.removed.map((entry) => entry.pid)).toEqual([gonePid]);
  });

  test("keeps entries past the wall-clock budget and retries them on the next pass", async () => {
    const first = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    const second = spawnProbe(tmpDir, liveChildren, ["--provider-marker=opencode"]);
    await waitUntilProbeReady(first);
    await waitUntilProbeReady(second);

    recordAgentProcess(
      buildExpiredOrphanEntry({ pid: first.pid, ownerDaemonId: "previous-daemon-generation" }),
      { filePath, logger },
    );
    recordAgentProcess(
      buildExpiredOrphanEntry({ pid: second.pid, ownerDaemonId: "previous-daemon-generation" }),
      { filePath, logger },
    );

    const logs: string[] = [];
    const captureLogger = pino({ level: "warn" }, { write: (line) => logs.push(line) });
    // Budget already spent: the reaper must not start signalling at all, must
    // keep both records, and must say so. Without this a registry full of stuck
    // entries would block the daemon's event loop indefinitely.
    const result = reapStaleAgentProcesses({
      filePath,
      logger: captureLogger,
      budgetMs: 0,
      killScope: () => {
        throw new Error("must not signal past the budget");
      },
      readScopePopulation: () => ({ known: true, populated: true, pids: [first.pid] }),
      sleepMs: () => {},
    });
    expect(result.removed).toEqual([]);
    expect(result.kept.map((entry) => entry.pid)).toEqual([first.pid, second.pid]);
    expect(readAgentProcessRegistry({ filePath })).toHaveLength(2);
    expect(logs.some((line) => line.includes("wall-clock budget"))).toBe(true);
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

// Real-systemd proof of the scope-membership contract. Everything above runs
// against an injected reader; these run against a real `systemd --user` session
// and a real `KillMode=process` scope, because the whole defect lives in how
// systemd reports a scope, not in how this code reads a fake one.
//
// They skip where there is no systemd user session (a typical CI runner) and say
// so out loud. Set PASEO_REQUIRE_SYSTEMD_TESTS=1 to turn a skip into a failure,
// so a run that is supposed to have exercised the real path cannot report green
// without having done so.
describe.skipIf(process.platform !== "linux")("scope membership (real systemd)", () => {
  let tmpDir: string;
  let filePath: string;
  let spawnedChild: ReturnType<typeof spawn> | null = null;
  let canScope = false;
  let unitName = "";
  let grandchildPid: number | null = null;
  // The zombie fixture forks a heartbeat writer that outlives its launcher, so
  // killing the scope's main process is not by itself enough to clean up.
  const fixturePids: number[] = [];
  const scopeChildren: ReturnType<typeof spawn>[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-process-scope-members-"));
    filePath = path.join(tmpDir, "agent-processes.json");
    canScope = probeAgentScopeRoundTrip().ok;
    grandchildPid = null;
  });

  afterEach(() => {
    // Unconditional: a fixture that timed out would otherwise leave a real,
    // heartbeat-writing process in a real scope on the host.
    if (grandchildPid !== null) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (unitName) {
      try {
        spawnSync(
          "systemctl",
          ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", "--", unitName],
          { stdio: "ignore" },
        );
      } catch {
        // unit already collected
      }
      unitName = "";
    }
    for (const child of scopeChildren.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    killPids(fixturePids.splice(0));
    if (spawnedChild && spawnedChild.exitCode === null && spawnedChild.signalCode === null) {
      spawnedChild.kill("SIGKILL");
    }
    spawnedChild = null;
    __setAgentProcessScopeDetectionForTests(null);
    __setAgentProcessScopeProbeForTests(null);
    setAgentProcessRegistryHome(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Skip loudly rather than pretending the real path ran. */
  function requireRealScope(): boolean {
    if (canScope) return true;
    const message =
      "[agent-process-registry] real systemd scope unavailable; scope-membership e2e skipped";
    if (process.env.PASEO_REQUIRE_SYSTEMD_TESTS === "1") {
      throw new Error(message);
    }
    console.warn(message);
    return false;
  }

  /**
   * A scope whose main process runs `process.execPath` and spawns a grandchild
   * that IGNORES SIGTERM. That is the real-world shape this defect is about: an
   * ACP adapter exits on stdin EOF when the daemon dies, and the dev servers it
   * started stay in the scope. Measured on systemd 259: `systemctl kill
   * --kill-whom=all --signal=SIGTERM` leaves the grandchild running with
   * `cgroup.procs` non-empty, and only SIGKILL clears it.
   *
   * `exitMain` decides whether the main process outlives the grandchild's start
   * (so the SIGTERM escalation is what has to do the work) or exits on its own
   * (so the classification of a dead main pid is what has to do the work).
   */
  function spawnScopeWithSurvivingGrandchild(exitMain: boolean): Promise<{ mainPid: number }> {
    const gcPidFile = path.join(tmpDir, "grandchild.pid");
    const beatFile = path.join(tmpDir, "grandchild.beat");
    const mainReadyFile = path.join(tmpDir, "main.pid");
    const grandchildCode = [
      'const fs = require("node:fs");',
      // Installing a SIGTERM listener suppresses node's default terminate
      // action, so this process provably survives a scope-wide SIGTERM.
      'process.on("SIGTERM", () => {});',
      `fs.writeFileSync(${JSON.stringify(gcPidFile)}, String(process.pid));`,
      // A heartbeat proves the process is not merely present but still running,
      // which `kill(pid, 0)` alone cannot show and which survives pid reuse.
      `setInterval(() => fs.writeFileSync(${JSON.stringify(beatFile)}, String(Date.now())), 100);`,
    ].join("");
    const mainCode = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      // detached so the grandchild sits in its own process group and is
      // reparented to systemd --user when the main dies, rather than lingering
      // as a zombie child of the test process.
      `const gc = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}],`,
      '  { stdio: "ignore", detached: true });',
      "gc.unref();",
      `fs.writeFileSync(${JSON.stringify(mainReadyFile)}, String(process.pid));`,
      exitMain
        ? `const w = setInterval(() => { if (fs.existsSync(${JSON.stringify(gcPidFile)})) { clearInterval(w); process.exit(0); } }, 25);`
        : "setInterval(() => {}, 1000);",
    ].join("");

    setAgentProcessRegistryHome(tmpDir);
    __setAgentProcessScopeDetectionForTests({ available: true, reason: "forced by test" });
    __setAgentProcessScopeProbeForTests(() => ({ ok: true, reason: "forced by test" }));

    spawnedChild = spawnInAgentScope(
      process.execPath,
      ["-e", mainCode, "--", "--provider-marker=orphan"],
      { stdio: "ignore" },
      { provider: "scope-membership-test", logger },
    );
    const mainPid = spawnedChild.pid as number;
    unitName = "";

    return (async () => {
      // systemd-run execs the target into the scope asynchronously; wait for the
      // real fixture, not for the spawn call to return.
      await expect.poll(() => existsSync(gcPidFile), { timeout: 15_000, interval: 50 }).toBe(true);
      await expect
        .poll(() => existsSync(mainReadyFile), { timeout: 15_000, interval: 50 })
        .toBe(true);
      grandchildPid = Number(readFileSync(gcPidFile, "utf8"));
      expectPidAlive(grandchildPid, "the grandchild must be running before the assertions start");
      expect(isPidRunning(grandchildPid), "the grandchild is not a zombie").toBe(true);
      return { mainPid };
    })().then(async (result) => {
      const recorded = readAgentProcessRegistry({ filePath, logger });
      expect(recorded).toHaveLength(1);
      unitName = recorded[0].unit;
      expect(isSignalableAgentScopeUnit(recorded[0])).toBe(true);
      return result;
    });
  }

  /** Prove a process is gone without racing pid reuse: pid absent AND heartbeat frozen. */
  async function expectProcessStopped(
    pid: number,
    beatFile: string,
    context: string,
  ): Promise<void> {
    await expect.poll(() => isPidAlive(pid), { timeout: 10_000, interval: 50 }).toBe(false);
    const before = readFileSync(beatFile, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readFileSync(beatFile, "utf8"), `${context}: the heartbeat must be frozen`).toBe(before);
  }

  function ageIntoExpiredOrphan(): AgentProcessEntry {
    const entry = readAgentProcessRegistry({ filePath, logger })[0];
    recordAgentProcess(
      {
        ...entry,
        ownerDaemonId: "previous-daemon-generation",
        orphanedAt: new Date(
          Date.now() - AGENT_PROCESS_UNOWNED_RECORD_TTL_MS - 60_000,
        ).toISOString(),
      },
      { filePath, logger },
    );
    return readAgentProcessRegistry({ filePath, logger })[0];
  }

  test("SIGKILLs a scope member that ignores SIGTERM and only then drops its record", async () => {
    if (!requireRealScope()) return;
    const beatFile = path.join(tmpDir, "grandchild.beat");
    const { mainPid } = await spawnScopeWithSurvivingGrandchild(false);
    const entry = ageIntoExpiredOrphan();

    // Real cgroup identity with no seam: the scope genuinely holds both the main
    // process and the grandchild.
    expect(readAgentScopePopulation(entry)).toMatchObject({
      known: true,
      populated: true,
    });
    expect(classifyAgentProcessEntry(entry)).toBe("live-matching");
    expectPidAlive(grandchildPid as number, "the grandchild is running before the reap");

    const logs: string[] = [];
    const captureLogger = pino({ level: "warn" }, { write: (line) => logs.push(line) });
    // No killScope and no sleepMs: this drives the real `systemctl kill` path and
    // the real bounded wait. The grace is shortened but NOT set to zero — a zero
    // timeout re-checks immediately and would report a successful SIGKILL as a
    // failure.
    const result = reapStaleAgentProcesses({
      filePath,
      logger: captureLogger,
      termGraceMs: 500,
      killTimeoutMs: 5_000,
    });

    // The ONLY discriminating assertion: on the pid-only code this reap reported
    // "terminated with SIGTERM" the moment the main pid died, removed the record,
    // and left this grandchild running.
    await expectProcessStopped(
      grandchildPid as number,
      beatFile,
      "a scope member that ignores SIGTERM must still be killed",
    );

    // The stop can only have been reported after SIGKILL, because SIGTERM
    // provably cannot clear a scope whose member ignores it.
    const stopped = logs.find((line) => line.includes("orphan-stopped"));
    expect(stopped, "the reap logs the stopped orphan").toBeTruthy();
    expect(stopped).toContain("scope cgroup emptied after SIGKILL");

    expect(result.removed.map((entry2) => entry2.pid)).toEqual([mainPid]);
    expect(readAgentProcessRegistry({ filePath, logger })).toEqual([]);
    expect(isPidRunning(mainPid), "the scope's main process is stopped too").toBe(false);
  });

  test("keeps the record of a scope whose main exited while a member survived, then kills the member", async () => {
    if (!requireRealScope()) return;
    const beatFile = path.join(tmpDir, "grandchild.beat");
    const { mainPid } = await spawnScopeWithSurvivingGrandchild(true);

    // The main process exits on its own. The grandchild is still in the scope:
    // under KillMode=process nothing else is killed, which is the real-world
    // orphan shape.
    await expect.poll(() => isPidAlive(mainPid), { timeout: 15_000, interval: 50 }).toBe(false);
    const entry = readAgentProcessRegistry({ filePath, logger })[0];

    // A dead main pid with a populated scope is NOT dead. Pinning the exact value
    // matters: anything else is dropped by the reaper without a signal.
    expect(classifyAgentProcessEntry(entry)).toBe("live-matching");
    expect(readAgentScopePopulation(entry)).toMatchObject({
      known: true,
      populated: true,
    });
    expectPidAlive(grandchildPid as number, "the survivor outlives the main process");

    // So a fresh reap keeps the record and signals nothing.
    const fresh = reapStaleAgentProcesses({ filePath, logger });
    expect(fresh.removed).toEqual([]);
    expect(fresh.kept.map((kept) => kept.pid)).toEqual([mainPid]);
    expect(readAgentProcessRegistry({ filePath, logger })).toHaveLength(1);
    expectPidAlive(grandchildPid as number, "a reap inside the window never signals");

    // Past the window the survivor is killed for real and only then is the
    // record dropped.
    ageIntoExpiredOrphan();
    const expired = reapStaleAgentProcesses({
      filePath,
      logger,
      termGraceMs: 500,
      killTimeoutMs: 5_000,
    });
    await expectProcessStopped(
      grandchildPid as number,
      beatFile,
      "the orphan the record existed for must be killed",
    );
    expect(expired.removed.map((removed) => removed.pid)).toEqual([mainPid]);
    expect(readAgentProcessRegistry({ filePath, logger })).toEqual([]);
  });

  test("reports a collected scope as unpopulated instead of reading the cgroup root", async () => {
    if (!requireRealScope()) return;
    // A collected unit reports an EMPTY ControlGroup. Joining that onto the
    // cgroup mount point would resolve to the cgroup ROOT, which holds every
    // process on the host — so every scope would look permanently populated and
    // no record would ever be dropped again.
    const scopeId = `paseo-agent-${process.pid}-0123456789ab`;
    const population = readAgentScopePopulation({
      scopeId,
      unit: `${scopeId}.scope`,
      pid: process.pid,
      provider: "never-spawned",
      startedAt: new Date().toISOString(),
    });
    expect(population).toMatchObject({ known: true, populated: false, pids: [] });
    expect(population.pids, "the cgroup root must never be read as this scope").not.toContain(
      process.pid,
    );
  });

  test("keeps the record when the scope of a dead main pid is still populated", async () => {
    if (!requireRealScope()) return;
    const { mainPid } = await spawnScopeWithSurvivingGrandchild(true);
    await expect.poll(() => isPidAlive(mainPid), { timeout: 15_000, interval: 50 }).toBe(false);

    // The detach-stop flush is the other pid-only deletion path: on the old code
    // it dropped the record of a dead main pid even with a live member, which is
    // how a detach-stop used to orphan a survivor permanently.
    const flush = flushLiveAgentProcesses({ filePath, logger });
    expect(flush.removed).toEqual([]);
    expect(flush.kept.map((kept) => kept.pid)).toEqual([mainPid]);
    expect(readAgentProcessRegistry({ filePath, logger })).toHaveLength(1);
    expectPidAlive(grandchildPid as number, "the survivor stays tracked across a flush");
  });

  // The strongest form of the zombie defect: a REAL `KillMode=process` scope
  // whose recorded main pid is a genuine unreaped child (state `Z`, empty
  // `/proc/<pid>/cmdline`, still answering `kill(pid, 0)`) while a real member
  // keeps running in the scope.
  //
  // The fixtures above all drive the "main pid exited and was reaped" shape,
  // which takes the `!isPidAlive` branch. That is why they pass on the code that
  // answered `dead` for an empty cmdline without ever asking the scope.
  test("keeps the record of a real scope whose main pid is an unreaped child", async () => {
    if (!requireRealScope()) return;
    if (!requireZombieLauncher()) return;

    const paths = writeZombieLauncher(tmpDir);
    setAgentProcessRegistryHome(tmpDir);
    __setAgentProcessScopeDetectionForTests({ available: true, reason: "forced by test" });
    __setAgentProcessScopeProbeForTests(() => ({ ok: true, reason: "forced by test" }));

    const launcherPid = spawnZombieLauncher(paths, scopeChildren, { scoped: true });
    spawnedChild = scopeChildren[scopeChildren.length - 1] ?? null;
    const fixture = await waitForZombieFixture(paths, launcherPid);
    fixturePids.push(fixture.launcherPid, fixture.zombiePid, fixture.memberPid);

    // The unit `spawnInAgentScope` recorded is the scope the fixture lives in;
    // swap only the pid, so the registry holds exactly one entry whose main pid is
    // the zombie this launcher created.
    const recorded = readAgentProcessRegistry({ filePath, logger });
    expect(recorded, "the scoped fixture must record one entry").toHaveLength(1);
    unitName = recorded[0].unit;
    expect(isSignalableAgentScopeUnit(recorded[0])).toBe(true);
    expect(forgetAgentProcess(recorded[0].pid, { filePath, logger })).toBe(true);
    const entry: AgentProcessEntry = { ...recorded[0], pid: fixture.zombiePid };
    expect(recordAgentProcess(entry, { filePath, logger })).toBe(true);

    // PRECONDITION: the pid really is a zombie, and really is inside this scope.
    // Asserted before anything is concluded from its classification, because a
    // reaped-then-reused pid would answer `kill(pid, 0)` just as happily.
    expectRealZombie(fixture.zombiePid);
    expect(readFileSync(`/proc/${fixture.zombiePid}/cgroup`, "utf8")).toContain(unitName);
    expect(isPidRunning(fixture.memberPid), "the scope member is a real running process").toBe(
      true,
    );

    // The scope is populated by the live member — a zombie is deliberately absent
    // from `cgroup.procs` (it holds no resources), so it is the member that keeps
    // the scope from being provably empty.
    const population = readAgentScopePopulation(entry);
    expect(population).toMatchObject({ known: true, populated: true });
    expect(population.pids, "the live member is what holds the scope open").toContain(
      fixture.memberPid,
    );

    // No seam anywhere in this assertion: the real reader, the real cgroup, the
    // real zombie. This is the line the fix moves.
    expect(classifyAgentProcessEntry(entry)).toBe("live-matching");

    // And end to end: a real reap must keep the record and signal nothing.
    const logs: string[] = [];
    const captureLogger = pino({ level: "warn" }, { write: (line) => logs.push(line) });
    const result = reapStaleAgentProcesses({
      filePath,
      logger: captureLogger,
      sleepMs: () => {},
      termGraceMs: 500,
      killTimeoutMs: 5_000,
    });
    expect(result.removed, "a zombie main pid must not cost the record").toEqual([]);
    expect(result.kept.map((kept) => kept.pid)).toEqual([fixture.zombiePid]);
    expect(readAgentProcessRegistry({ filePath, logger }).map((kept) => kept.pid)).toEqual([
      fixture.zombiePid,
    ]);
    expect(
      logs.some((line) => line.includes("orphan-stopped")),
      "nothing may be signalled while the record is owned by this daemon",
    ).toBe(false);
    expect(isPidRunning(fixture.memberPid), "the survivor is untouched").toBe(true);

    // The detach-stop flush must agree, on the real reader.
    const flush = flushLiveAgentProcesses({ filePath, logger });
    expect(flush.removed).toEqual([]);
    expect(flush.kept.map((kept) => kept.pid)).toEqual([fixture.zombiePid]);

    // Still a zombie at the end of all of that: nothing reaped it behind our back.
    expectRealZombie(fixture.zombiePid);
  });
});
