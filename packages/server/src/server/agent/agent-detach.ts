import type { Logger } from "pino";

import { readAgentProcessRegistry } from "./agent-process-registry.js";

/**
 * Detach-on-stop: when this env var is set at daemon start, a graceful daemon
 * stop leaves scoped provider children running (in their systemd user scopes)
 * instead of cancel/closeSession/tree-killing them, so a deploy bounce
 * (`systemctl --user restart paseo`) does not destroy in-flight agent turns.
 * The next daemon discovers the survivors through $PASEO_HOME/agent-processes.json
 * (adoption is a later slice).
 *
 * Unset (the default): stop terminates children exactly as it does today.
 *
 * Detach is decided per child: only children recorded in the scope registry
 * (i.e. spawned inside an S2 systemd user scope) are spared. A child outside
 * the registry cannot outlive the daemon's cgroup under systemd and would
 * become an unadoptable orphan if left running, so it keeps today's teardown.
 */
export const DETACH_AGENTS_ON_STOP_ENV = "PASEO_DETACH_AGENTS_ON_STOP";

export function isDetachAgentsOnStopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DETACH_AGENTS_ON_STOP_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

let detachStopActive = false;

/**
 * Engage detach for this daemon stop. Idempotent; call at stop() entry (and
 * anywhere a stop is first observed) before any agent closes. Returns true
 * only when the env var enabled detach — false means "stop as usual".
 */
export function beginAgentDetachStop(logger?: Logger): boolean {
  if (detachStopActive) {
    return true;
  }
  if (!isDetachAgentsOnStopEnabled()) {
    return false;
  }
  detachStopActive = true;
  logger?.info(
    { env: DETACH_AGENTS_ON_STOP_ENV },
    "Detach-on-stop enabled: scoped agent children will be left running",
  );
  return true;
}

export function isAgentDetachStopActive(): boolean {
  return detachStopActive;
}

/**
 * True only while a detach-stop is running AND pid has an entry in the S2
 * scope registry. Fast path returns false without touching the registry file,
 * so normal stops and normal agent closes behave byte-for-byte as before.
 */
export function shouldDetachAgentProcess(pid?: number | null): boolean {
  if (!detachStopActive) {
    return false;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  return readAgentProcessRegistry().some((entry) => entry.pid === pid);
}

/**
 * Test-only: clear the in-process detach-stop state between tests.
 */
export function __resetAgentDetachForTests(): void {
  detachStopActive = false;
}
