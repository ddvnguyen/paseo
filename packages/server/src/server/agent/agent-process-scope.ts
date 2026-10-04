import { execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";

import { spawnProcess, type SpawnProcessOptions } from "../../utils/spawn.js";
import type { AgentProcessEntry } from "./agent-process-registry.js";
import { forgetAgentProcess, recordAgentProcess } from "./agent-process-registry.js";

export interface AgentScopeSpawnMeta {
  provider: string;
  sessionId?: string;
  logger?: Logger;
}

export interface AgentScopeDetection {
  available: boolean;
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
  if (detectionOverride) return detectionOverride;
  if (!cachedDetection) {
    cachedDetection = detectAgentProcessScope();
  }
  return cachedDetection;
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
      if (detection.available) {
        invocation = buildAgentScopeInvocation(command, args);
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
    const forget = () => {
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
 * once-per-process detection state.
 */
export function __setAgentProcessScopeDetectionForTests(
  detection: AgentScopeDetection | null,
): void {
  detectionOverride = detection;
  cachedDetection = null;
  detectionLogged = false;
}
