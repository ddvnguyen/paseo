import { createHash } from "node:crypto";

/**
 * Harness-injected context the ledger could not see through a hook.
 *
 * `before("agent.create")` is the only place a caller-configured systemPrompt
 * reaches a plugin, and it carries no agent id. The daemon's OWN appended
 * instructions are worse off: `daemonAppendSystemPrompt` lives only on the
 * server-internal AgentSessionConfig (agent/agent-sdk-types.ts) and is
 * deliberately never persisted, so it is absent from the protocol config a
 * plugin receives on that hook — and it is applied AFTER the hook runs
 * (agent-manager.ts: createAgentInternal awaits `before("agent.create")`, then
 * calls prepareSessionConfig, which calls applyDaemonAppendSystemPrompt). No
 * stream event, no hook payload, nothing per-agent.
 *
 * The daemon config is the one place it is written down, and the SDK exposes it
 * read-only as `paseo.config.get()`. So that is what this module samples, at
 * create time, and attributes to the agent by TIME WINDOW: the value is global
 * to the daemon, the read and the injection happen microseconds apart inside
 * one create, and there is no per-agent hook that could prove the pairing. The
 * row says `correlated: "time-window"` rather than claiming a match.
 *
 * PRIVACY: length and a 12-char digest only, never the text — same rule as the
 * caller-prompt row (d-893c722f28). The digest is what makes two runs
 * comparable without the prompt being readable.
 */

/** Hex chars of the digest kept. Long enough to compare, not a fingerprint. */
export const HASH_CHARS = 12;

/** sha256 as lowercase hex, from the builtin so the plugin stays dependency-free. */
export function hash12(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, HASH_CHARS);
}

/** A prompt reduced to what the ledger is allowed to keep. */
export interface PromptFacts {
  charsLength: number;
  hash12: string;
}

/** One row to record, as the recorder takes it minus the agent id. */
export interface AttributedPrompt extends PromptFacts {
  source: "caller" | "daemon-append";
  correlated: "config" | "fifo" | "time-window";
}

/**
 * The slice of the SDK client this module reads. Structural on purpose: the
 * real `PaseoApi` satisfies it, and a test needs no client.
 */
export interface ConfigReadable {
  config: {
    get(): Promise<{ config: { appendSystemPrompt?: string | undefined } }>;
  };
}

/**
 * Sample the daemon's appended instructions, reduced to length and hash.
 *
 * null means "nothing to record", and it covers three cases that must not be
 * conflated: the setting is unset, the read failed, or the value is only
 * whitespace. The daemon itself trims before injecting
 * (`applyDaemonAppendSystemPrompt` reads `this.appendSystemPrompt.trim()`), so
 * the facts describe the trimmed string — the text that actually reaches the
 * provider — and a whitespace-only setting is no injection at all.
 *
 * Never throws. This runs on the `before("agent.create")` path, where a thrown
 * error fails the agent creation itself, and a missing context row is cosmetic.
 */
export async function sampleDaemonAppend(paseo: ConfigReadable): Promise<PromptFacts | null> {
  let raw: string | undefined;
  try {
    const { config } = await paseo.config.get();
    raw = config.appendSystemPrompt;
  } catch (error) {
    console.error("[trajectory] daemon appendSystemPrompt read failed", error);
    return null;
  }
  if (typeof raw !== "string") return null;
  const injected = raw.trim();
  if (injected.length === 0) return null;
  return { charsLength: injected.length, hash12: hash12(injected) };
}

/** What one create staged, waiting for the agent id that will own it. */
interface StagedCreate {
  key: string;
  caller: PromptFacts | null;
  daemonAppend: PromptFacts | null;
}

/**
 * Cap on staged-but-unclaimed creates.
 *
 * A create that never reaches `agent.created` (a failed launch, an internal
 * agent) leaks its entry, and this queue is hotter than it was: any create with
 * a daemon append stages an entry, not only the ones carrying a caller prompt.
 * Overflow drops the OLDEST entry, which is the one least likely to still be
 * waiting on an id, and the drop is logged rather than silent.
 */
export const MAX_STAGED_CREATES = 64;

/**
 * Staged create-time context, matched to agents on the way out.
 *
 * The create hook has the config but no agent id; `agent.created` has the id but
 * no config, and the daemon exposes no request id on either. Entries are
 * therefore matched on provider + cwd + title, with an oldest-first fallback
 * when they disagree — the same best-effort pairing the caller-prompt rows
 * shipped with, now carrying a second fact per create.
 */
export class PendingContextQueue {
  private readonly entries: StagedCreate[] = [];

  /**
   * Stage one create. Facts that are both null are not staged at all: an entry
   * with nothing in it can only ever produce zero rows, and queueing those would
   * let a create with no context at all displace a real match under FIFO.
   */
  stage(input: {
    key: string;
    caller: PromptFacts | null;
    daemonAppend: PromptFacts | null;
  }): void {
    if (input.caller === null && input.daemonAppend === null) return;
    this.entries.push(input);
    while (this.entries.length > MAX_STAGED_CREATES) {
      const dropped = this.entries.shift();
      console.error("[trajectory] pending context overflow, dropped oldest create", dropped?.key);
    }
  }

  /** Staged creates still waiting for an agent. Diagnostics and tests. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Claim the entry that belongs to this agent and return the rows to record.
   *
   * Empty when nothing was staged, which is the normal case for an agent whose
   * create hook did not run (a resume, or a plugin registered after the agent
   * existed) — no row is invented for it.
   */
  take(agent: { key: string }): AttributedPrompt[] {
    const exact = this.entries.findIndex((entry) => entry.key === agent.key);
    if (this.entries.length === 0) return [];
    const [entry] = this.entries.splice(exact === -1 ? 0 : exact, 1);
    if (entry === undefined) return [];
    const rows: AttributedPrompt[] = [];
    if (entry.caller !== null) {
      // A fallback claim is not a match, and the row says so.
      rows.push({
        ...entry.caller,
        source: "caller",
        correlated: exact === -1 ? "fifo" : "config",
      });
    }
    if (entry.daemonAppend !== null) {
      // Global, not per-agent: there is nothing to match on, so the correlation
      // is the create window regardless of which entry was claimed.
      rows.push({
        ...entry.daemonAppend,
        source: "daemon-append",
        correlated: "time-window",
      });
    }
    return rows;
  }
}

/**
 * The identity both create-side and created-side payloads agree on.
 *
 * NUL-separated, so no combination of provider/cwd/title values can forge
 * another agent's key by moving a separator character into a value.
 */
export function contextKeyOf(parts: {
  provider: string;
  cwd: string;
  title?: string | null;
}): string {
  return `${parts.provider}\u0000${parts.cwd}\u0000${parts.title ?? ""}`;
}
