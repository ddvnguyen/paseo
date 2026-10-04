import { readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import { resolvePaseoHome } from "../paseo-home.js";
import { writePrivateFileAtomicSync } from "../private-files.js";

export const AGENT_PROCESS_REGISTRY_FILE = "agent-processes.json";

export const AgentProcessEntrySchema = z.object({
  scopeId: z.string().min(1),
  unit: z.string().min(1),
  pid: z.number().int().positive(),
  provider: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  startedAt: z.string().min(1),
});

export type AgentProcessEntry = z.infer<typeof AgentProcessEntrySchema>;

const AgentProcessRegistrySchema = z.array(AgentProcessEntrySchema);

export interface AgentProcessRegistryOptions {
  filePath?: string;
  logger?: Logger;
}

export interface ReapResult {
  removed: AgentProcessEntry[];
  kept: AgentProcessEntry[];
}

export type AgentProcessClassification = "dead" | "recycled" | "live-matching";

let registryHomeOverride: string | null = null;

/**
 * Pin the registry to one daemon home. `createPaseoDaemon` calls this with
 * `config.paseoHome` so spawn-time recording and startup reaping agree on the
 * daemon's home even when tests pass an explicit `paseoHome` without setting
 * `PASEO_HOME` in the environment. Pass `null` to fall back to env resolution.
 */
export function setAgentProcessRegistryHome(home: string | null): void {
  registryHomeOverride = home;
}

/**
 * Registry path follows the daemon's home so spawn-time recording and startup
 * reaping always agree on one file.
 */
export function resolveAgentProcessRegistryPath(): string {
  return path.join(registryHomeOverride ?? resolvePaseoHome(), AGENT_PROCESS_REGISTRY_FILE);
}

/**
 * Read the registry. A missing file yields []; a corrupt file (bad JSON or
 * wrong shape) also yields [] so callers recover instead of crashing.
 */
export function readAgentProcessRegistry(
  options: AgentProcessRegistryOptions = {},
): AgentProcessEntry[] {
  const filePath = options.filePath ?? resolveAgentProcessRegistryPath();
  const logger = options.logger;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      logger?.warn({ err: error, filePath }, "Failed to read agent process registry");
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger?.warn({ filePath }, "Agent process registry is not valid JSON; starting empty");
    return [];
  }
  const result = AgentProcessRegistrySchema.safeParse(parsed);
  if (!result.success) {
    logger?.warn(
      { filePath, issues: result.error.issues },
      "Agent process registry has an unexpected shape; starting empty",
    );
    return [];
  }
  return result.data;
}

/**
 * Add (or replace) the entry for a pid. Never throws: on any failure the
 * registry simply has no entry recorded.
 */
export function recordAgentProcess(
  entry: AgentProcessEntry,
  options: AgentProcessRegistryOptions = {},
): boolean {
  const filePath = options.filePath ?? resolveAgentProcessRegistryPath();
  const logger = options.logger;
  try {
    const validated = AgentProcessEntrySchema.parse(entry);
    const current = readAgentProcessRegistry({ filePath, logger });
    const next = current.filter((existing) => existing.pid !== validated.pid);
    next.push(validated);
    writePrivateFileAtomicSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch (error) {
    logger?.warn({ err: error, filePath, pid: entry.pid }, "Failed to record agent process");
    return false;
  }
}

/**
 * Drop the entry for a pid (idempotent). Never throws.
 */
export function forgetAgentProcess(
  pid: number,
  options: AgentProcessRegistryOptions = {},
): boolean {
  const filePath = options.filePath ?? resolveAgentProcessRegistryPath();
  const logger = options.logger;
  try {
    const current = readAgentProcessRegistry({ filePath, logger });
    const next = current.filter((entry) => entry.pid !== pid);
    if (next.length === current.length) {
      return true;
    }
    writePrivateFileAtomicSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  } catch (error) {
    logger?.warn({ err: error, filePath, pid }, "Failed to forget agent process");
    return false;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface ProcessIdentity {
  cmdline: string;
  comm: string;
  exe: string;
}

/**
 * Best-effort identity read, same idea as deploy/systemd/paseo-prestart.sh:
 * cmdline + comm (+ exe) is what a recycled pid cannot fake.
 */
function readProcessIdentity(pid: number): ProcessIdentity | null {
  const base = `/proc/${pid}`;
  try {
    const cmdline = readFileSync(`${base}/cmdline`, "utf8").replaceAll("\u0000", " ").trim();
    const comm = readFileSync(`${base}/comm`, "utf8").trim();
    let exe = "";
    try {
      exe = readlinkSync(`${base}/exe`);
    } catch {
      // exe is a symlink that can vanish or be unreadable; it is only extra evidence.
    }
    return { cmdline, comm, exe };
  } catch {
    return null;
  }
}

function matchesProviderMarker(identity: ProcessIdentity, provider: string): boolean {
  const needle = provider.trim().toLowerCase();
  if (!needle) return false;
  const haystack = `${identity.cmdline} ${identity.comm} ${identity.exe}`.toLowerCase();
  return haystack.includes(needle);
}

/**
 * Classify one registry entry:
 * - dead: pid is gone (or vanished mid-check / no cmdline — an exited zombie)
 * - recycled: pid is alive but the process is not the expected provider
 * - live-matching: pid is alive and matches the provider marker
 */
export function classifyAgentProcessEntry(entry: AgentProcessEntry): AgentProcessClassification {
  if (!isPidAlive(entry.pid)) return "dead";
  if (process.platform !== "linux") {
    // /proc is unavailable; liveness is all we can verify off Linux.
    return "live-matching";
  }
  const identity = readProcessIdentity(entry.pid);
  if (!identity) return "dead";
  if (!identity.cmdline) return "dead";
  return matchesProviderMarker(identity, entry.provider) ? "live-matching" : "recycled";
}

/** Flush outcome: records kept because the pid is alive, records dropped. */
export interface FlushResult {
  kept: AgentProcessEntry[];
  removed: AgentProcessEntry[];
}

/**
 * Detach-stop flush: drop entries whose pid is gone, keep every entry whose
 * pid is still alive (no provider-marker check — a live pid is enough to
 * guarantee the next daemon can look at it; its startup reap decides
 * live-vs-recycled). Never throws: a registry failure degrades to "nothing
 * flushed".
 */
export function flushLiveAgentProcesses(options: AgentProcessRegistryOptions = {}): FlushResult {
  const filePath = options.filePath ?? resolveAgentProcessRegistryPath();
  const logger = options.logger;
  try {
    const entries = readAgentProcessRegistry({ filePath, logger });
    const kept: AgentProcessEntry[] = [];
    const removed: AgentProcessEntry[] = [];
    for (const entry of entries) {
      (isPidAlive(entry.pid) ? kept : removed).push(entry);
    }
    if (removed.length > 0) {
      writePrivateFileAtomicSync(filePath, `${JSON.stringify(kept, null, 2)}\n`);
    }
    logger?.info(
      { filePath, kept: kept.length, removed: removed.length },
      "Agent process registry flushed for detach stop",
    );
    return { kept, removed };
  } catch (error) {
    logger?.warn({ err: error, filePath }, "Agent process registry flush failed; continuing");
    return { kept: [], removed: [] };
  }
}

/**
 * Startup reaper: drop dead and recycled entries, leave live matching ones
 * alone (adoption/reattach is a later slice). Never throws — a registry
 * failure degrades to "nothing reaped", never a daemon crash.
 */
export function reapStaleAgentProcesses(options: AgentProcessRegistryOptions = {}): ReapResult {
  const filePath = options.filePath ?? resolveAgentProcessRegistryPath();
  const logger = options.logger;
  try {
    const entries = readAgentProcessRegistry({ filePath, logger });
    const removed: AgentProcessEntry[] = [];
    const kept: AgentProcessEntry[] = [];
    for (const entry of entries) {
      const classification = classifyAgentProcessEntry(entry);
      if (classification === "live-matching") {
        kept.push(entry);
        continue;
      }
      removed.push(entry);
      logger?.info(
        { filePath, pid: entry.pid, provider: entry.provider, unit: entry.unit, classification },
        "Reaped stale agent process registry entry",
      );
    }
    if (removed.length > 0) {
      writePrivateFileAtomicSync(filePath, `${JSON.stringify(kept, null, 2)}\n`);
    }
    logger?.info(
      { filePath, removed: removed.length, kept: kept.length },
      "Agent process registry reaped",
    );
    return { removed, kept };
  } catch (error) {
    logger?.warn({ err: error, filePath }, "Agent process registry reap failed; continuing");
    return { removed: [], kept: [] };
  }
}
