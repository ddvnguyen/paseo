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

/**
 * Optional hard ceiling on a scoped child's lifetime, in seconds.
 *
 * OFF by default on purpose: a fixed ceiling would SIGTERM a legitimately
 * long-lived agent that this daemon still owns, which is a worse failure than
 * a slow orphan bound. Operators who want systemd itself to cap runaway
 * children (a crash-looping daemon leaving scopes behind, a wedged provider)
 * opt in with this env var. The startup reaper's stop path is the always-on
 * bound; this is the belt to its braces.
 */
export const AGENT_SCOPE_MAX_RUNTIME_ENV = "PASEO_AGENT_SCOPE_MAX_RUNTIME_SEC";

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

/**
 * Probe failures that mean "this session cannot host scopes", as opposed to a
 * momentary hiccup. Anything that could plausibly be transient stays on the
 * backoff path.
 */
const HARD_PROBE_FAILURE_PATTERN =
  /(Failed to connect to bus|No such file or directory|Connection refused|not been booted|Unknown assignment|Access denied|Permission denied|Operation not permitted|Failed to create|scope unit|systemd-run: not found)/i;

/** First cooldown after a transient probe failure; doubles per consecutive failure. */
const AGENT_SCOPE_TRANSIENT_PROBE_BACKOFF_START_MS = 30_000;
const AGENT_SCOPE_TRANSIENT_PROBE_BACKOFF_MAX_MS = 5 * 60_000;

let cachedDetection: AgentScopeDetection | null = null;
let detectionLogged = false;
let detectionOverride: AgentScopeDetection | null = null;
// Hard failures (no bus, systemd cannot host scopes at all) disable scoping for
// the rest of the process: retrying per spawn would only multiply the failure.
// Transient failures get a cooldown instead, so one 5s-timeout does not
// silently disable scoping for the whole daemon lifetime.
let hardDowngradeReason: string | null = null;
let transientDowngradeUntil = 0;
let transientDowngradeReason: string | null = null;
let transientBackoffMs = AGENT_SCOPE_TRANSIENT_PROBE_BACKOFF_START_MS;
// A successful round trip is cached: the probe is a synchronous execFileSync that
// can block for seconds on a hung bus, and one success is enough evidence that
// this session can host scopes.
let probeSuccessCached = false;
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
  // A hard failed round trip wins over any (test) override: the downgrade
  // sticks for the process lifetime so one bad spawn never retriggers
  // systemd-run on the next one.
  if (hardDowngradeReason) return { available: false, reason: hardDowngradeReason };
  if (detectionOverride) return detectionOverride;
  if (!cachedDetection) {
    cachedDetection = detectAgentProcessScope();
  }
  return cachedDetection;
}

/**
 * Record a failed round-trip probe. Hard failures (the session cannot host
 * scopes) are sticky; anything else only cools scoping down for a bounded,
 * doubling window so a transient timeout does not disable scoping forever.
 */
function noteScopeProbeFailure(reason: string): { hard: boolean; retryAfterMs: number } {
  if (HARD_PROBE_FAILURE_PATTERN.test(reason)) {
    hardDowngradeReason = reason;
    return { hard: true, retryAfterMs: Number.POSITIVE_INFINITY };
  }
  transientDowngradeReason = reason;
  transientDowngradeUntil = Date.now() + transientBackoffMs;
  transientBackoffMs = Math.min(transientBackoffMs * 2, AGENT_SCOPE_TRANSIENT_PROBE_BACKOFF_MAX_MS);
  return { hard: false, retryAfterMs: transientBackoffMs };
}

function getTransientDowngrade(): AgentScopeDetection | null {
  if (Date.now() >= transientDowngradeUntil) {
    transientDowngradeReason = null;
    return null;
  }
  return {
    available: false,
    reason: `${transientDowngradeReason ?? "scope probe failed"}; retrying in ${Math.ceil(
      (transientDowngradeUntil - Date.now()) / 1000,
    )}s`,
  };
}

/**
 * Real round-trip check: run a harmless transient scope to completion. This is
 * the only way to know systemd-run can actually execute the target — `--version`
 * succeeding says nothing about whether the unit can start (bus gone, no
 * permission, bad unit). Never throws.
 */
export function probeAgentScopeRoundTrip(): AgentScopeProbeResult {
  if (probeOverride) return probeOverride();
  // One success is enough for this process: caching keeps a synchronous probe
  // (up to 5s on a hung bus) off the path of every later spawn.
  if (probeSuccessCached) {
    return { ok: true, reason: "scope round trip already succeeded in this process" };
  }
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
    probeSuccessCached = true;
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
    // A relative command resolves against the spawn's cwd, not the daemon's
    // process.cwd(). Checking process.cwd() would report an unresolvable
    // command as resolvable (and silently skip scoping) or vice versa.
    const cwd = resolveSpawnCwd(options);
    const resolved =
      path.isAbsolute(command) || cwd === null ? command : path.resolve(cwd, command);
    try {
      accessSync(resolved, fsConstants.X_OK);
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

/** Spawn cwd as a plain path; Node's `SpawnOptions.cwd` may also be a URL. */
function resolveSpawnCwd(options?: SpawnProcessOptions): string | null {
  const cwd = options?.cwd;
  if (cwd === undefined) return process.cwd();
  if (typeof cwd === "string") return cwd;
  try {
    return cwd.pathname ? path.resolve(cwd.pathname) : null;
  } catch {
    return null;
  }
}

/**
 * True when the spawn's cwd is missing or is not a directory. Scoping such a
 * spawn would surface as `spawn systemd-run ENOENT`, which reads exactly like a
 * missing binary; a plain spawn surfaces the real cwd error instead.
 */
export function hasUsableSpawnCwd(options?: SpawnProcessOptions): boolean {
  const cwd = options?.cwd;
  if (cwd === undefined) return true;
  const resolved = resolveSpawnCwd(options);
  if (resolved === null) return false;
  try {
    return statSync(resolved).isDirectory();
  } catch {
    return false;
  }
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
 * Operator-set hard ceiling for a scoped child's lifetime, in seconds, or null
 * when unset/invalid. See AGENT_SCOPE_MAX_RUNTIME_ENV for why this is opt-in.
 */
export function resolveAgentScopeRuntimeMaxSec(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env[AGENT_SCOPE_MAX_RUNTIME_ENV]?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.floor(seconds);
}

/**
 * Build the systemd-run invocation for one agent scope. Pure so the shape can
 * be verified without a systemd user session.
 */
export function buildAgentScopeInvocation(
  command: string,
  args: string[],
  options?: { runtimeMaxSec?: number | null },
): AgentScopeInvocation {
  const scopeId = `paseo-agent-${process.pid}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const runtimeMaxSec = options?.runtimeMaxSec ?? null;
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
      // Verified honoured on scope units (systemd 259: RuntimeMaxUSec is set
      // and the unit is stopped once it elapses).
      ...(runtimeMaxSec === null ? [] : [`--property=RuntimeMaxSec=${runtimeMaxSec}`]),
      "--collect",
      "--",
      command,
      ...args,
    ],
  };
}

/**
 * Record a freshly scoped child. An unrecorded orphan cannot be found, killed or
 * adopted by anyone, so a failed write is logged at error level with the unit
 * (recoverable by hand) and retried once in case the failure was transient.
 */
function recordScopedAgentChild(entry: AgentProcessEntry, logger?: Logger): void {
  if (recordAgentProcess(entry, { logger })) {
    return;
  }
  logger?.error(
    { unit: entry.unit, scopeId: entry.scopeId, pid: entry.pid, provider: entry.provider },
    "Failed to record scoped agent child in the registry; retrying once",
  );
  if (recordAgentProcess(entry, { logger })) {
    return;
  }
  logger?.error(
    { unit: entry.unit, scopeId: entry.scopeId, pid: entry.pid, provider: entry.provider },
    "Scoped agent child is running untracked; stop it manually with: systemctl --user kill --kill-whom=all " +
      entry.unit,
  );
}

/**
 * Decide whether this spawn goes through a scope, and build the invocation if
 * so. Split out of `spawnInAgentScope` so the decision tree stays readable and
 * the spawn function stays a straight-line spawn. Never throws.
 */
function resolveScopeInvocation(
  command: string,
  args: string[],
  options: SpawnProcessOptions | undefined,
  logger: Logger | undefined,
): AgentScopeInvocation | null {
  if (!hasUsableSpawnCwd(options)) {
    // Plain spawn: the caller then sees the real cwd error instead of a
    // `spawn systemd-run ENOENT` that looks like a missing binary.
    logger?.warn(
      { cwd: options?.cwd, command },
      "Agent process scope skipped: spawn cwd is missing or not a directory",
    );
    return null;
  }
  const transient = getTransientDowngrade();
  const detection = getScopeDetection();
  const effective = transient ?? detection;
  logDetectionOnce(effective, logger);
  if (!effective.available || transient || !isCommandResolvableOnPath(command, options)) {
    return null;
  }
  const probe = probeAgentScopeRoundTrip();
  if (probe.ok) {
    return buildAgentScopeInvocation(command, args, {
      runtimeMaxSec: resolveAgentScopeRuntimeMaxSec(),
    });
  }
  const failure = noteScopeProbeFailure(probe.reason);
  logger?.warn(
    {
      reason: probe.reason,
      command,
      sticky: failure.hard,
      retryInMs: failure.retryAfterMs === Number.POSITIVE_INFINITY ? null : failure.retryAfterMs,
    },
    failure.hard
      ? "Agent process scope probe failed; downgrading to plain spawn for the rest of this process"
      : "Agent process scope probe failed transiently; plain spawn until the retry window elapses",
  );
  return null;
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
      invocation = resolveScopeInvocation(command, args, options, logger);
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
    recordScopedAgentChild(entry, logger);
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
 * once-per-process detection state, including any probe downgrade.
 */
export function __setAgentProcessScopeDetectionForTests(
  detection: AgentScopeDetection | null,
): void {
  detectionOverride = detection;
  cachedDetection = null;
  detectionLogged = false;
  hardDowngradeReason = null;
  transientDowngradeReason = null;
  transientDowngradeUntil = 0;
  transientBackoffMs = AGENT_SCOPE_TRANSIENT_PROBE_BACKOFF_START_MS;
  probeSuccessCached = false;
}

/**
 * Test-only: force (or clear) the systemd-run round-trip probe result.
 */
export function __setAgentProcessScopeProbeForTests(
  probe: (() => AgentScopeProbeResult) | null,
): void {
  probeOverride = probe;
}
