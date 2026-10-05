import { describe, expect, test, afterEach, beforeEach } from "vitest";
import { once } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import pino from "pino";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  classifyAgentProcessEntry,
  flushLiveAgentProcesses,
  isPidAlive,
  readAgentProcessRegistry,
} from "./agent-process-registry.js";
import {
  __setAgentProcessScopeDetectionForTests,
  __setAgentProcessScopeProbeForTests,
  buildAgentScopeInvocation,
  hasUsableSpawnCwd,
  isCommandResolvableOnPath,
  probeAgentScopeRoundTrip,
  resolveAgentScopeRuntimeMaxSec,
  spawnInAgentScope,
} from "./agent-process-scope.js";

const logger = createTestLogger();
const thisDir = path.dirname(fileURLToPath(import.meta.url));
const scopeModulePath = path.join(thisDir, "agent-process-scope.ts");
const tsxBin = path.resolve(thisDir, "../../../node_modules/.bin/tsx");
// Probe once at collection: e2e survival claims require a real systemd user
// session that can host scopes; anywhere else the test skips.
const realScopeProbe = process.platform === "linux" ? probeAgentScopeRoundTrip() : { ok: false };

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
  let fixtureChild: ReturnType<typeof spawn> | null = null;
  let grandchildPid: number | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-process-scope-"));
    previousPaseoHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = tmpDir;
    fixtureChild = null;
    grandchildPid = null;
  });

  afterEach(() => {
    if (fixtureChild && fixtureChild.exitCode === null) {
      fixtureChild.kill("SIGKILL");
    }
    if (grandchildPid !== null) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    __setAgentProcessScopeDetectionForTests(null);
    __setAgentProcessScopeProbeForTests(null);
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

  // Finding 6: only meaningful where systemd-run can really round-trip a scope.
  test.skipIf(!realScopeProbe.ok)(
    "spawns through systemd-run when the scope is available and records an entry",
    async () => {
      __setAgentProcessScopeDetectionForTests({ available: true, reason: "forced by test" });
      __setAgentProcessScopeProbeForTests(() => ({ ok: true, reason: "forced by test" }));
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
    },
  );

  test("falls back to a plain spawn with a loud warning when the scope probe fails", async () => {
    const logs: string[] = [];
    const captureLogger = pino({ level: "warn" }, { write: (line) => logs.push(line) });
    let probeCalls = 0;
    __setAgentProcessScopeDetectionForTests({ available: true, reason: "forced by test" });
    __setAgentProcessScopeProbeForTests(() => {
      probeCalls += 1;
      return { ok: false, reason: "user bus gone" };
    });

    const first = spawnInAgentScope(
      process.execPath,
      ["-e", "setTimeout(() => {}, 50)"],
      { stdio: "ignore" },
      { provider: "scope-test", logger: captureLogger },
    );
    expect(String(first.spawnfile)).not.toContain("systemd-run");

    // "user bus gone" is ambiguous, so it is treated as TRANSIENT: scoping is
    // skipped without re-probing until the cooldown window elapses. A hard
    // failure would instead pin the downgrade for the rest of the process.
    const second = spawnInAgentScope(
      process.execPath,
      ["-e", "setTimeout(() => {}, 50)"],
      { stdio: "ignore" },
      { provider: "scope-test", logger: captureLogger },
    );
    expect(String(second.spawnfile)).not.toContain("systemd-run");
    expect(probeCalls).toBe(1);

    // No scope attempt means no scope registry records.
    expect(
      readAgentProcessRegistry({ filePath: path.join(tmpDir, "agent-processes.json") }),
    ).toEqual([]);

    const warning = logs.find((line) => line.includes("scope probe failed"));
    expect(warning, "probe failure logs a loud warning").toBeTruthy();
    expect(warning).toContain("user bus gone");

    await Promise.all([once(first, "close"), once(second, "close")]);
  });

  // A single hung bus must not disable scoping for the whole daemon lifetime,
  // but a session that genuinely cannot host scopes must not be retried per
  // spawn either.
  test("keeps a hard probe failure sticky for the process and re-probes after a transient one", async () => {
    __setAgentProcessScopeDetectionForTests({ available: true, reason: "forced by test" });
    let probeCalls = 0;
    let reason = "Failed to connect to bus: No medium found";
    __setAgentProcessScopeProbeForTests(() => {
      probeCalls += 1;
      return { ok: false, reason };
    });

    const first = spawnInAgentScope(
      process.execPath,
      ["-e", "setTimeout(() => {}, 50)"],
      { stdio: "ignore" },
      { provider: "scope-test", logger },
    );
    const second = spawnInAgentScope(
      process.execPath,
      ["-e", "setTimeout(() => {}, 50)"],
      { stdio: "ignore" },
      { provider: "scope-test", logger },
    );
    expect(String(first.spawnfile)).not.toContain("systemd-run");
    expect(String(second.spawnfile)).not.toContain("systemd-run");
    // Hard failure: scoping stays off and the probe is never called again for
    // the rest of this process.
    expect(probeCalls).toBe(1);
    const third = spawnInAgentScope(
      process.execPath,
      ["-e", "setTimeout(() => {}, 50)"],
      { stdio: "ignore" },
      { provider: "scope-test", logger },
    );
    expect(String(third.spawnfile)).not.toContain("systemd-run");
    expect(probeCalls).toBe(1);
    await Promise.all([once(first, "close"), once(second, "close"), once(third, "close")]);
  });

  test("resolves a relative command against the spawn cwd, not the daemon cwd", async () => {
    __setAgentProcessScopeDetectionForTests({ available: true, reason: "forced by test" });
    __setAgentProcessScopeProbeForTests(() => ({ ok: true, reason: "forced by test" }));
    const cwd = mkdtempSync(path.join(os.tmpdir(), "agent-scope-cwd-"));
    const relative = "./provider-binary";
    writeFileSync(path.join(cwd, "provider-binary"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    try {
      expect(isCommandResolvableOnPath(relative, { cwd })).toBe(true);
      expect(isCommandResolvableOnPath(relative)).toBe(false);
      expect(hasUsableSpawnCwd({ cwd })).toBe(true);
      expect(hasUsableSpawnCwd({ cwd: path.join(cwd, "no-such-dir") })).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a missing cwd plain-spawns so the caller sees the cwd error, not a missing binary", async () => {
    __setAgentProcessScopeDetectionForTests({ available: true, reason: "forced by test" });
    __setAgentProcessScopeProbeForTests(() => ({ ok: true, reason: "forced by test" }));
    const missingCwd = path.join(tmpDir, "no-such-cwd");
    const child = spawnInAgentScope(
      process.execPath,
      ["-e", "setTimeout(() => {}, 50)"],
      { cwd: missingCwd, stdio: "ignore" },
      { provider: "scope-test", logger },
    );
    // Plain spawn: the ENOENT now names the command the caller asked for
    // instead of `spawn systemd-run ENOENT`, which reads like a missing
    // provider binary.
    expect(String(child.spawnfile)).toBe(process.execPath);
    const [error] = (await once(child, "error")) as [NodeJS.ErrnoException];
    expect(error.code).toBe("ENOENT");
    expect(String(error.syscall ?? "")).toContain(process.execPath);
    expect(String(error.syscall ?? "")).not.toContain("systemd-run");
  });

  test("adds RuntimeMaxSec only when an operator opts in", () => {
    const withoutCap = buildAgentScopeInvocation("opencode", ["serve"]);
    expect(withoutCap.args.some((arg) => arg.startsWith("--property=RuntimeMaxSec"))).toBe(false);

    const previous = process.env.PASEO_AGENT_SCOPE_MAX_RUNTIME_SEC;
    try {
      process.env.PASEO_AGENT_SCOPE_MAX_RUNTIME_SEC = "3600";
      expect(resolveAgentScopeRuntimeMaxSec()).toBe(3600);
      const capped = buildAgentScopeInvocation("opencode", ["serve"], {
        runtimeMaxSec: resolveAgentScopeRuntimeMaxSec(),
      });
      expect(capped.args).toContain("--property=RuntimeMaxSec=3600");

      // Nonsense values fall back to "no ceiling" rather than a broken unit.
      process.env.PASEO_AGENT_SCOPE_MAX_RUNTIME_SEC = "-5";
      expect(resolveAgentScopeRuntimeMaxSec()).toBeNull();
      process.env.PASEO_AGENT_SCOPE_MAX_RUNTIME_SEC = "not-a-number";
      expect(resolveAgentScopeRuntimeMaxSec()).toBeNull();
    } finally {
      if (previous === undefined) {
        delete process.env.PASEO_AGENT_SCOPE_MAX_RUNTIME_SEC;
      } else {
        process.env.PASEO_AGENT_SCOPE_MAX_RUNTIME_SEC = previous;
      }
    }
  });

  test("a missing command still surfaces as a normal ENOENT spawn error", async () => {
    let probeCalls = 0;
    __setAgentProcessScopeDetectionForTests({ available: true, reason: "forced by test" });
    __setAgentProcessScopeProbeForTests(() => {
      probeCalls += 1;
      return { ok: true, reason: "forced by test" };
    });

    const missing = path.join(tmpDir, "definitely-not-a-real-provider-binary");
    const child = spawnInAgentScope(
      missing,
      ["serve"],
      { stdio: "ignore" },
      { provider: "scope-test", logger },
    );
    // The unresolvable command never reaches systemd-run (which would swallow
    // ENOENT into a unit start failure); it spawns plainly so the caller sees
    // the standard 'error' event.
    expect(child.spawnfile).toBe(missing);
    expect(probeCalls).toBe(0);
    const [error] = (await once(child, "error")) as [NodeJS.ErrnoException];
    expect(error.code).toBe("ENOENT");
  });

  // Finding 3: the survival claim under review. A scoped child that ignores
  // stdin EOF keeps running after the parent that held its stdio pipes dies:
  // it observes EOF (pipes really closed) and stays alive (scope not torn
  // down). Skipped where there is no real systemd session to scope into.
  test.skipIf(!realScopeProbe.ok)(
    "keeps a piped grandchild running after its parent dies, even with stdin EOF",
    async () => {
      const registryPath = path.join(tmpDir, "agent-processes.json");
      const grandchildScript = path.join(tmpDir, "grandchild.cjs");
      const statusFile = path.join(tmpDir, "grandchild-status.json");
      const readyFile = path.join(tmpDir, "fixture-ready.json");
      const fixtureFile = path.join(tmpDir, "fixture.mts");

      writeFileSync(grandchildScript, GRANDCHILD_SOURCE);
      writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(fixtureFile, buildFixtureSource());

      fixtureChild = spawn(tsxBin, [fixtureFile, statusFile, readyFile, grandchildScript], {
        stdio: "ignore",
        env: { ...process.env, PASEO_HOME: tmpDir },
      });

      await expect.poll(() => existsSync(readyFile), { timeout: 10_000, interval: 100 }).toBe(true);
      const ready = JSON.parse(readFileSync(readyFile, "utf8")) as {
        fixturePid: number;
        grandchildPid: number;
      };
      grandchildPid = ready.grandchildPid;
      expect(grandchildPid).toBeGreaterThan(0);

      // Real cgroup identity: the registry entry classifies live-matching with
      // no test seam, proving finding 2's primary path on a real scoped pid.
      await expect
        .poll(() => readRegistryClassification(registryPath, grandchildPid), {
          timeout: 10_000,
          interval: 100,
        })
        .toBe("live-matching");

      // Kill the parent: the pipes its child reads stdin from now hit EOF.
      process.kill(ready.fixturePid, "SIGKILL");

      await expect
        .poll(
          () => {
            try {
              const status = JSON.parse(readFileSync(statusFile, "utf8")) as {
                sawStdinEnd: boolean;
              };
              return status.sawStdinEnd === true;
            } catch {
              return false;
            }
          },
          { timeout: 10_000, interval: 100 },
        )
        .toBe(true);

      expect(() => process.kill(grandchildPid as number, 0)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(() => process.kill(grandchildPid as number, 0)).not.toThrow();
    },
  );

  test("does not wipe a registry entry when a live child emits a spurious exit", async () => {
    __setAgentProcessScopeDetectionForTests({ available: true, reason: "forced by test" });
    const registryPath = path.join(tmpDir, "agent-processes.json");
    const child = spawnInAgentScope(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
      { provider: "scope-test", logger },
    );
    expect(child.pid).toBeGreaterThan(0);
    expect(readAgentProcessRegistry({ filePath: registryPath })).toHaveLength(1);
    const pid = child.pid as number;

    // A daemon-teardown exit can surface while the scoped child is still
    // alive; the record must survive so the next daemon can adopt the child.
    child.emit("exit", 0, null);
    expect(isPidAlive(pid)).toBe(true);
    expect(readAgentProcessRegistry({ filePath: registryPath })).toHaveLength(1);

    // The real exit lands next, but the once-listener already fired; the
    // detach-stop flush is what finally drops the dead pid.
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
    const flush = flushLiveAgentProcesses({ filePath: registryPath, logger });
    expect(flush.removed.map((entry) => entry.pid)).toContain(pid);
    expect(readAgentProcessRegistry({ filePath: registryPath })).toEqual([]);
  });
});

const GRANDCHILD_SOURCE = `
const fs = require("node:fs");
const statusFile = process.argv[2];
let sawStdinEnd = false;
function report() {
  fs.writeFileSync(statusFile, JSON.stringify({ pid: process.pid, sawStdinEnd, alive: true }));
}
process.stdin.on("end", () => {
  sawStdinEnd = true;
  report();
});
process.stdin.on("close", () => {
  if (!sawStdinEnd) {
    sawStdinEnd = true;
    report();
  }
});
// Without resume() the stream stays paused and EOF is never observed.
process.stdin.resume();
report();
setInterval(report, 200);
`;

function readRegistryClassification(registryPath: string, pid: number | null): string {
  const entry = readAgentProcessRegistry({ filePath: registryPath }).find(
    (candidate) => candidate.pid === pid,
  );
  return entry ? classifyAgentProcessEntry(entry) : "missing";
}

function buildFixtureSource(): string {
  return [
    `import { writeFileSync } from "node:fs";`,
    `import { spawnInAgentScope } from ${JSON.stringify(scopeModulePath)};`,
    `const statusFile = process.argv[2];`,
    `const readyFile = process.argv[3];`,
    `const script = process.argv[4];`,
    `const child = spawnInAgentScope(`,
    `  process.execPath,`,
    `  [script, statusFile],`,
    `  { stdio: ["pipe", "pipe", "pipe"] },`,
    `  { provider: "claude-acp" },`,
    `);`,
    `child.on("error", () => {});`,
    `writeFileSync(readyFile, JSON.stringify({ fixturePid: process.pid, grandchildPid: child.pid }));`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");
}
