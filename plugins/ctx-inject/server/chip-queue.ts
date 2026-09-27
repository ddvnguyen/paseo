import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { CtxInjectChipData } from "../shared/ctx-schema.js";
import { configFacts, type ConfigFacts, type SnapshotControls } from "./ctx-capture.js";

/**
 * Decides WHEN the chip row may be written.
 *
 * The daemon commits an agent to agent-manager some time after the hooks run, and
 * the plugin API exposes no event for "the agent is now live". Both observed
 * races come from that gap:
 *
 * - QC round 8, a fresh create: `agent.session_open` is pre-commit, and the
 *   append failed with "Unknown agent" ~770ms before "Created agent". A create
 *   therefore parks its row until `agent.created` (the post-commit signal).
 * - QC round 9, a resume: the agent is in the store but not yet live when
 *   `agent.session_open` runs, so the inline write was rejected the same way.
 *   There is no deterministic signal for this one — `agent.created` explicitly
 *   excludes resume — so a bounded retry is the only option.
 *
 * Retrying is scoped to the "agent not available yet" condition, which is
 * detected two ways: an explicit `probe` that reports the agent as not live, and
 * an "Unknown agent" rejection. Any other error fails fast, because retrying a
 * schema violation or a closed session just delays the report.
 */

export interface StagedChip {
  agentId: string;
  facts: ConfigFacts | null;
  provider: string;
  reason: string;
  purpose: string;
}

/** Whether the agent is available, and its controls if so. */
export interface ProbeResult {
  live: boolean;
  controls: SnapshotControls | null;
}

/** Host operations the queue needs, injected so the ordering is testable. */
export interface ChipSink {
  /**
   * Is the agent live in agent-manager yet? Read at flush time, never at
   * session-open time, where a create is not yet committed.
   */
  probe(staged: StagedChip): Promise<ProbeResult>;
  buildData(staged: StagedChip, controls: SnapshotControls | null): Promise<CtxInjectChipData>;
  append(agentId: string, data: CtxInjectChipData): Promise<void>;
  /** Failures are always reported; a dropped chip row must never be silent. */
  onError(agentId: string, stage: "append" | "build" | "not-live", error: unknown): void;
}

/** Unbound create facts older than this are dropped rather than misattributed. */
const PENDING_TTL_MS = 60_000;
/** A staged row whose agent never materialises is dropped after this. */
const STAGED_TTL_MS = 120_000;
/** Backstop against an unbounded map if many creations fail to commit. */
const STAGED_MAX = 256;

export interface RetryPolicy {
  /** Total attempts, including the first. */
  attempts: number;
  /** Delay before attempt n+1, indexed from 0. */
  backoffMs: number[];
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 4,
  // ~1.7s total, inside the window a manager load is expected to take.
  backoffMs: [200, 500, 1000],
};

/**
 * The rejection the daemon returns while an agent is in the store but not yet
 * live: "Request failed: Unknown agent '<id>' ... code=handler_error".
 */
function isNotAvailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown agent/i.test(message);
}

interface Timed<T> {
  at: number;
  value: T;
}

export interface SessionOpenInput {
  agentId: string;
  provider: string;
  cwd: string;
  reason: string;
  purpose: string;
}

/** provider + cwd: the two identity fields both hooks expose. */
function pendingKey(provider: string, cwd: string): string {
  return `${provider}\u0000${cwd}`;
}

export class ChipQueue {
  private readonly pendingCreates = new Map<string, Timed<ConfigFacts>[]>();
  private readonly staged = new Map<string, Timed<StagedChip>>();

  constructor(
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Stage 1: reduce the spawn config while we are the only ones who can see it. */
  captureCreate(provider: string, cwd: string, config: AgentSessionConfig): void {
    const key = pendingKey(provider, cwd);
    const bucket = this.pendingCreates.get(key) ?? [];
    bucket.push({ at: Date.now(), value: configFacts(config) });
    this.pendingCreates.set(key, bucket);
  }

  /** Oldest unexpired fact for this agent's bucket, or null when none is ours. */
  private takePending(provider: string, cwd: string): ConfigFacts | null {
    const key = pendingKey(provider, cwd);
    const bucket = this.pendingCreates.get(key);
    if (!bucket) return null;
    const now = Date.now();
    while (bucket.length > 0) {
      const entry = bucket.shift()!;
      // Expired means the matching session open never arrived; dropping it keeps a
      // later, unrelated open from inheriting a stale config.
      if (now - entry.at <= PENDING_TTL_MS) return entry.value;
    }
    this.pendingCreates.delete(key);
    return null;
  }

  private sweepStaged(now: number): void {
    for (const [agentId, entry] of this.staged) {
      if (now - entry.at > STAGED_TTL_MS) this.staged.delete(agentId);
    }
  }

  /**
   * Stage 2. A `create` is parked until `agent.created`; every other reason runs
   * inline and relies on the retry, because the agent already exists in the store
   * and only needs to become live.
   */
  async handleSessionOpen(request: SessionOpenInput, sink: ChipSink): Promise<void> {
    const staged: StagedChip = {
      agentId: request.agentId,
      facts: this.takePending(request.provider, request.cwd),
      provider: request.provider,
      reason: request.reason,
      purpose: request.purpose,
    };

    if (request.reason === "create") {
      this.sweepStaged(Date.now());
      // Bounded so repeated failures cannot grow the map without limit.
      if (this.staged.size >= STAGED_MAX) {
        const oldest = this.staged.keys().next();
        if (!oldest.done) this.staged.delete(oldest.value);
      }
      this.staged.set(request.agentId, { at: Date.now(), value: staged });
      return;
    }

    await this.flush(request.agentId, staged, sink);
  }

  /** Post-commit signal: the agent exists, so the parked row can be written. */
  async handleAgentCreated(agentId: string, sink: ChipSink): Promise<void> {
    const entry = this.staged.get(agentId);
    if (!entry) return;
    this.staged.delete(agentId);
    if (Date.now() - entry.at > STAGED_TTL_MS) return;
    await this.flush(agentId, entry.value, sink);
  }

  /**
   * Write the row, retrying only while the agent is unavailable. The controls
   * come from the probe that preceded a successful attempt, so a resume reads
   * model/mode only once the agent is actually live.
   */
  private async flush(agentId: string, staged: StagedChip, sink: ChipSink): Promise<void> {
    for (let attempt = 0; attempt < this.retry.attempts; attempt += 1) {
      const isLast = attempt === this.retry.attempts - 1;
      try {
        const probe = await sink.probe(staged);
        if (!probe.live) {
          if (isLast) {
            sink.onError(
              agentId,
              "not-live",
              new Error("agent never became available for the ctx-inject chip"),
            );
            return;
          }
          await this.sleep(this.backoffFor(attempt));
          continue;
        }

        let data: CtxInjectChipData;
        try {
          data = await sink.buildData(staged, probe.controls);
        } catch (error) {
          sink.onError(agentId, "build", error);
          return;
        }
        await sink.append(agentId, data);
        return;
      } catch (error) {
        // A rejection because the agent is not live yet is recoverable; anything
        // else is a real fault and retrying would only delay the report.
        if (isLast || !isNotAvailable(error)) {
          sink.onError(agentId, "append", error);
          return;
        }
        await this.sleep(this.backoffFor(attempt));
      }
    }
  }

  private backoffFor(attempt: number): number {
    return this.retry.backoffMs[attempt] ?? this.retry.backoffMs.at(-1) ?? 0;
  }

  clear(): void {
    this.pendingCreates.clear();
    this.staged.clear();
  }

  /** Test/diagnostic surface; never used to drive behaviour. */
  get stagedCount(): number {
    return this.staged.size;
  }
}

export type { ConfigFacts, SnapshotControls };
