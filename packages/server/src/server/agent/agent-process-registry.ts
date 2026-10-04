import { randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import { resolvePaseoHome } from "../paseo-home.js";
import { writePrivateFileAtomicSync } from "../private-files.js";

export const AGENT_PROCESS_REGISTRY_FILE = "agent-processes.json";

/**
 * Records whose owning daemon generation is gone (previous daemon, crash loop,
 * legacy file without an owner) are dropped from the registry after this age.
 * The child is never signalled — only the record goes — and the reap is logged
 * loudly with the scope name so an operator can still find the orphan. Keeps
 * unowned live records from accumulating forever while adoption stays a later
 * slice, without ever expiring records this daemon owns.
 */
export const AGENT_PROCESS_UNOWNED_RECORD_TTL_MS = 24 * 60 * 60 * 1000;

export const AgentProcessEntrySchema = z.object({
  scopeId: z.string().min(1),
  unit: z.string().min(1),
  pid: z.number().int().positive(),
  provider: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  startedAt: z.string().min(1),
  // Generation of the daemon process that recorded the entry; absent on files
  // written before this field existed. Optional so old registries still parse.
  ownerDaemonId: z.string().min(1).optional(),
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
 * Identity of the daemon process recording entries right now. One random value
 * per process: after a daemon restart every existing record belongs to a
 * previous generation, which is what lets the reaper tell this daemon's live
 * records apart from unowned orphans.
 */
const ownerDaemonId = randomUUID();

export function getAgentProcessOwnerDaemonId(): string {
  return ownerDaemonId;
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
    // Stamp the recording daemon so startup reaping can tell this daemon's own
    // records from entries whose owning daemon generation is gone.
    const stamped: AgentProcessEntry = {
      ...validated,
      ownerDaemonId: validated.ownerDaemonId ?? ownerDaemonId,
    };
    const current = readAgentProcessRegistry({ filePath, logger });
    const next = current.filter((existing) => existing.pid !== stamped.pid);
    next.push(stamped);
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

function isPidAlive(pid: number): boolean {
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
 * Reads `/proc/<pid>/cgroup`. Overridable in tests: a real process cannot be
 * placed inside a fabricated scope cgroup, so scope-membership scenarios are
 * driven through this reader while liveness and cmdline stay real.
 */
type ProcessCgroupReader = (pid: number) => string | null;

let cgroupReaderOverride: ProcessCgroupReader | null = null;

export function __setAgentProcessCgroupReaderForTests(reader: ProcessCgroupReader | null): void {
  cgroupReaderOverride = reader;
}

function readCgroupDirect(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cgroup`, "utf8");
  } catch {
    return null;
  }
}

function readProcessCgroup(pid: number): string | null {
  if (cgroupReaderOverride) return cgroupReaderOverride(pid);
  return readCgroupDirect(pid);
}

/**
 * Scope unit name this process itself lives in, or null when it is not in a
 * scope (the normal case: the daemon runs in its unit cgroup). Read from the
 * real /proc, never through the test override. A recorded child spawned by
 * this very process shares our scope; that must not count as "foreign scope".
 * The test runner can itself run inside a scoped agent child, and probes it
 * spawns inherit that scope — treating it as recycled would break marker-based
 * classification in exactly the agent-driven workflow this feature targets.
 */
let ownProcessScope: string | null | undefined;

function getOwnProcessScope(): string | null {
  if (ownProcessScope === undefined) {
    ownProcessScope = extractScopeUnit(readCgroupDirect(process.pid));
  }
  return ownProcessScope;
}

/** First `<name>.scope` path segment in a cgroup text, or null. */
function extractScopeUnit(cgroup: string | null): string | null {
  if (cgroup === null) return null;
  const match = /(?:^|[/\n])([A-Za-z0-9_.:-]+\.scope)(?=[/\n]|$)/.exec(cgroup);
  return match ? match[1] : null;
}

/**
 * True when the pid is a member of the expected transient scope unit. A scope
 * is created only by `spawnInAgentScope`, and a recycled pid cannot fake
 * membership in its cgroup — this is the authoritative child identity.
 */
function cgroupHasScope(cgroup: string, scopeId: string): boolean {
  return cgroup.includes(`${scopeId}.scope`);
}

/**
 * True when the pid belongs to some scope unit that is neither the expected
 * scope nor this process's own scope. Membership in a different scope proves
 * the pid is not the recorded child (a recorded child lives only in its own
 * scope).
 */
function hasForeignScope(cgroup: string, entry: AgentProcessEntry): boolean {
  const ownScope = getOwnProcessScope();
  const expected = `${entry.scopeId}.scope`;
  const pattern = /(?:^|[/\n])([A-Za-z0-9_.:-]+\.scope)(?=[/\n]|$)/g;
  for (const match of cgroup.matchAll(pattern)) {
    if (match[1] !== expected && match[1] !== ownScope) return true;
  }
  return false;
}

/**
 * Classify one registry entry:
 * - dead: pid is gone (or vanished mid-check / no cmdline — an exited zombie)
 * - live-matching: pid is alive and a member of the entry's expected scope
 * - recycled: pid is alive but provably not the recorded child
 *
 * Identity is decided by cgroup membership first: the ACP spawn site records
 * provider ids like `claude-acp` while launching a different binary
 * (`prefix.command`), so cmdline markers alone can misclassify a live child as
 * recycled and drop its record while the process keeps running. A live pid in
 * the expected scope is therefore never recycled, whatever its cmdline says.
 *
 * A pid in some other scope (not the expected one, not ours) is recycled — it
 * cannot be the recorded child.
 *
 * Marker fallback (cmdline + comm + exe contains the provider id) applies only
 * when scope membership cannot speak for the entry: the expected scope no
 * longer exists (legacy record, unit collected) and the pid carries no foreign
 * scope either. Best effort either way; never applies to a pid alive in its
 * expected scope.
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
  const cgroup = readProcessCgroup(entry.pid);
  if (cgroup !== null) {
    if (cgroupHasScope(cgroup, entry.scopeId)) return "live-matching";
    if (hasForeignScope(cgroup, entry)) return "recycled";
  }
  return matchesProviderMarker(identity, entry.provider) ? "live-matching" : "recycled";
}

/**
 * Startup reaper: drop dead and recycled entries, leave live matching ones
 * alone (adoption/reattach is a later slice). Live records whose owning daemon
 * generation is gone are kept while fresh so a later adoption slice can still
 * find them; past AGENT_PROCESS_UNOWNED_RECORD_TTL_MS they are dropped with a
 * loud scope-naming warning so crash-loop orphans cannot pile up forever. The
 * reaper never signals processes. Never throws — a registry failure degrades
 * to "nothing reaped", never a daemon crash.
 */
export function reapStaleAgentProcesses(options: AgentProcessRegistryOptions = {}): ReapResult {
  const filePath = options.filePath ?? resolveAgentProcessRegistryPath();
  const logger = options.logger;
  try {
    const entries = readAgentProcessRegistry({ filePath, logger });
    const removed: AgentProcessEntry[] = [];
    const kept: AgentProcessEntry[] = [];
    const now = Date.now();
    for (const entry of entries) {
      const classification = classifyAgentProcessEntry(entry);
      if (classification === "live-matching") {
        const ownedByThisDaemon = entry.ownerDaemonId === ownerDaemonId;
        const ageMs = now - Date.parse(entry.startedAt);
        const expiredUnowned =
          !ownedByThisDaemon &&
          (!Number.isFinite(ageMs) || ageMs > AGENT_PROCESS_UNOWNED_RECORD_TTL_MS);
        if (expiredUnowned) {
          removed.push(entry);
          logger?.warn(
            {
              filePath,
              scopeId: entry.scopeId,
              unit: entry.unit,
              pid: entry.pid,
              provider: entry.provider,
              startedAt: entry.startedAt,
              ageMs: Number.isFinite(ageMs) ? ageMs : null,
              reason: "unowned-record-ttl",
            },
            `Reaped expired unowned agent scope record; child ${entry.unit} (pid ${entry.pid}) may still be running unmanaged`,
          );
          continue;
        }
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
