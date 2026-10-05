import type { Logger } from "pino";

import type { AgentCloseReason } from "./agent-sdk-types.js";
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
 *
 * ## Why this module holds no mutable state
 *
 * Detach intent is *call-scoped*, not ambient. An earlier revision kept a
 * process-global `detachStopActive` flag set once at `stop()` entry, and every
 * `session.close()` branched on it. `session.close()` is shared by the
 * daemon-stop path and the user path (`archive_agent` RPC, delete, reload,
 * draft-session probe closes), so for the whole stop window — up to
 * AGENT_CLOSE_TIMEOUT_MS per agent plus teardown — a user closing one agent
 * detached that agent's child instead of terminating it, leaking a live
 * provider process with a registry record nobody would ever reap.
 *
 * The fix is to carry `AgentCloseReason` on the close call itself
 * (`session.close({ reason: "daemon-stop" })`) and gate on THAT. Nothing here
 * is mutated after import, so there is no window in which user-originated
 * closes can observe detach intent.
 */
export const DETACH_AGENTS_ON_STOP_ENV = "PASEO_DETACH_AGENTS_ON_STOP";

/** The only close reason that may detach a provider child. */
export const DAEMON_STOP_CLOSE_REASON: AgentCloseReason = "daemon-stop";

export function isDetachAgentsOnStopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DETACH_AGENTS_ON_STOP_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * True when THIS close call may leave the provider child running.
 *
 * Both conditions are required and neither is ambient:
 *  1. the caller explicitly asked for a daemon-stop close, and
 *  2. the env opt-in is on, and
 *  3. `pid` has a live entry in the S2 scope registry.
 *
 * A close with any other reason (including no reason at all) always returns
 * false, so user-initiated closes terminate exactly as they did before
 * detach-on-stop existed — even mid-stop.
 *
 * The registry file is only read once conditions 1 and 2 hold, so normal
 * closes and normal agent teardown do not touch the filesystem at all.
 */
export function shouldDetachAgentProcess(
  pid: number | null | undefined,
  reason: AgentCloseReason | undefined,
): boolean {
  if (reason !== DAEMON_STOP_CLOSE_REASON) {
    return false;
  }
  if (!isDetachAgentsOnStopEnabled()) {
    return false;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  return readAgentProcessRegistry().some((entry) => entry.pid === pid);
}

/**
 * Log once per daemon that detach-on-stop is configured. Purely informational:
 * the decision itself is made per close call, never from process state.
 */
export function logDetachOnStopConfigured(logger: Logger): void {
  if (!isDetachAgentsOnStopEnabled()) {
    return;
  }
  logger.info(
    { env: DETACH_AGENTS_ON_STOP_ENV },
    "Detach-on-stop configured: a graceful daemon stop will leave scoped agent children running",
  );
}
