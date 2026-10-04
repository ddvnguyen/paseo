import { execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import { spawnProcess, type SpawnProcessOptions } from "../../utils/spawn.js";
import type { AgentProcessEntry } from "./agent-process-registry.js";
import { forgetAgentProcess, isPidAlive, recordAgentProcess } from "./agent-process-registry.js";

export interface AgentScopeSpawnMeta {
  provider: string;
  sessionId?: string;
  logger?: Logger;
}

export interface AgentScopeDetection {
  available: boolean;
  reason: string;
}

export interface AgentScopeProbeResult {
  ok: boolean;
  reason: string;
}

export interface AgentScopeInvocation {
  scopeId: string;
  unit: string;
  command: string;
  args: string[];
}

let cachedDetection: AgentScopeDetection | null = null;
let detectionLogged = false;
let detectionOverride: AgentScopeDetection | null = null;
// Sticky reason set when a systemd-run scope probe failed at spawn time; once
// set, every later spawn in this process uses a plain spawn.
let runtimeDowngradeReason: string | null = null;
// Test seam for the systemd-run round-trip probe.
let probeOverride: (() => AgentScopeProbeResult) | null = null;

/**
 * Probe once whether a systemd user session can host scope units.
 * Never throws: every failure mode degrades to "unavailable".
 */
function detectAgentProcessScope(): AgentScopeDetection {
  if (process.platform !== "linux") {
    return { available: false, reason: `platform ${process.platform} has no systemd` };
  }
  try {
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    if (!runtimeDir) {
      return { available: false, reason: "XDG_RUNTIME_DIR is not set" };
    }
    const userBus = path.join(runtimeDir, "bus");
    const stats = statSync(userBus);
    if (!stats.isSocket()) {
      return { available: false, reason: `${userBus} is not a socket` };
    }
    execFileSync("systemd-run", ["--version"], { stdio: "ignore", timeout: 5_000 });
    return { available: true, reason: "systemd user session reachable" };
  } catch (error) {
    return { available: false, reason: `systemd user session unavailable: ${String(error)}` };
  }
}

function getScopeDetection(): AgentScopeDetection {
  // A failed round-trip probe wins over any (test) override: the downgrade
  // sticks for the process lifetime so one bad spawn never retriggers
  // systemd-run on the next one.
  if (runtimeDowngradeReason) return { available: false, reason: runtimeDowngradeReason };
  if (detectionOverride) return detectionOverride;
  if (!cachedDetection) {
    cachedDetection = detectAgentProcessScope();
  }
  return cachedDetection;
}

/**
 * Real round-trip check: run a harmless transient scope to completion. This is
 * the only way to know systemd-run can actually execute the target — `--version`
 * succeeding says nothing about whether the unit can start (bus gone, no
 * permission, bad unit). Never throws.
 */
export function probeAgentScopeRoundTrip(): AgentScopeProbeResult {
  if (probeOverride) return probeOverride();
  try {
    execFileSync(
      "systemd-run",
      [
        "--user",
        "--scope",
        "--quiet",
        `--unit=paseo-agent-probe-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        "--property=KillMode=process",
        "--collect",
        "--",
        "/bin/true",
      ],
      { stdio: ["ignore", "ignore", "pipe"], timeout: 5_000 },
    );
    return { ok: true, reason: "scope round trip succeeded" };
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: Buffer | string }).stderr ?? "").trim()
        : "";
    return {
      ok: false,
      reason: stderr || `scope round trip failed: ${String(error)}`,
    };
  }
}

/**
 * Best-effort PATH resolvability check for the target command, using the same
 * env resolution spawnProcess uses. A command that cannot be resolved must
 * still surface as a normal spawn error (ENOENT on the plain-spawn 'error'
 * event), not as a scope probe failure — so this decides only whether to
 * attempt the scope at all, never whether the spawn is legal. Unresolvable
 * PATH (unset) assumes resolvable and lets spawn decide.
 */
export function isCommandResolvableOnPath(command: string, options?: SpawnProcessOptions): boolean {
  if (command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const baseEnv = options?.env ?? options?.baseEnv ?? process.env;
  const env = options?.envOverlay ? { ...baseEnv, ...options.envOverlay } : baseEnv;
  const pathValue = env.PATH ?? env.Path;
  if (!pathValue) return true;
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, command), fsConstants.X_OK);
      return true;
    } catch {
      // keep scanning PATH
    }
  }
  return false;
}

function logDetectionOnce(detection: AgentScopeDetection, logger?: Logger): void {
  if (detectionLogged || !logger) return;
  detectionLogged = true;
  if (detection.available) {
    logger.info(
      { reason: detection.reason },
      "Agent process scope enabled (children spawn in systemd user scopes)",
    );
  } else {
    logger.info(
      { reason: detection.reason },
      "Agent process scope unavailable; children spawn directly",
    );
  }
}

/**
 * Build the systemd-run invocation for one agent scope. Pure so the shape can
 * be verified without a systemd user session.
 */
export function buildAgentScopeInvocation(command: string, args: string[]): AgentScopeInvocation {
  const scopeId = `paseo-agent-${process.pid}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return {
    scopeId,
    unit: `${scopeId}.scope`,
    command: "systemd-run",
    args: [
      "--user",
      "--scope",
      "--quiet",
      `--unit=${scopeId}`,
      "--property=KillMode=process",
      "--collect",
      "--",
      command,
      ...args,
    ],
  };
}

/**
 * Spawn a provider child inside a transient systemd user scope so it outlives
 * the daemon process (the scope cgroup is a sibling of the daemon's unit
 * cgroup, not a member of it). Falls back to a plain spawn on non-Linux hosts
 * or when the systemd user session is unavailable; never throws where a plain
 * spawn would not.
 */
export function spawnInAgentScope(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
  meta?: AgentScopeSpawnMeta,
): ChildProcess {
  const logger = meta?.logger;
  let invocation: AgentScopeInvocation | null = null;
  if (!options?.shell) {
    try {
      const detection = getScopeDetection();
      logDetectionOnce(detection, logger);
      if (detection.available && isCommandResolvableOnPath(command, options)) {
        const probe = probeAgentScopeRoundTrip();
        if (probe.ok) {
          invocation = buildAgentScopeInvocation(command, args);
        } else {
          // One failed round trip downgrades every later spawn in this process
          // to plain spawn: systemd-run is up per detection, so this means the
          // session cannot host scopes right now and retrying per spawn would
          // only multiply the failure.
          runtimeDowngradeReason = probe.reason;
          logger?.warn(
            { reason: probe.reason, command },
            "Agent process scope probe failed; downgrading to plain spawn for the rest of this process",
          );
        }
      }
    } catch (error) {
      logger?.warn(
        { err: error, command },
        "Agent process scope detection failed; spawning without scope",
      );
      invocation = null;
    }
  }

  const child = invocation
    ? spawnProcess(invocation.command, invocation.args, options)
    : spawnProcess(command, args, options);

  if (invocation && typeof child.pid === "number") {
    const pid = child.pid;
    const entry: AgentProcessEntry = {
      scopeId: invocation.scopeId,
      unit: invocation.unit,
      pid,
      provider: meta?.provider || "unknown",
      sessionId: meta?.sessionId,
      startedAt: new Date().toISOString(),
    };
    recordAgentProcess(entry, { logger });
    // The spawner's exit/error event does not always mean the scoped child is
    // gone: daemon teardown can surface either first. Only drop the record once
    // the pid is actually dead, so a detach-stop never wipes a survivor the
    // next daemon needs to discover. Recycled pids are handled by the next
    // daemon's startup reap.
    const forget = () => {
      if (isPidAlive(pid)) {
        return;
      }
      forgetAgentProcess(pid, { logger });
    };
    child.once("exit", forget);
    child.once("error", forget);
    logger?.info(
      { scopeId: entry.scopeId, unit: entry.unit, pid, provider: entry.provider },
      "Spawned process inside agent scope",
    );
  }
  return child;
}

/**
 * Test-only: force (or clear) the scope detection result and reset the
 * once-per-process detection state, including any sticky probe downgrade.
 */
export function __setAgentProcessScopeDetectionForTests(
  detection: AgentScopeDetection | null,
): void {
  detectionOverride = detection;
  cachedDetection = null;
  detectionLogged = false;
  runtimeDowngradeReason = null;
}

/**
 * Test-only: force (or clear) the systemd-run round-trip probe result.
 */
export function __setAgentProcessScopeProbeForTests(
  probe: (() => AgentScopeProbeResult) | null,
): void {
  probeOverride = probe;
}
