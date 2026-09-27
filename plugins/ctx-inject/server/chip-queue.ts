import type { CtxInjectChipData } from "../shared/ctx-schema.js";
import { configFacts, type ConfigFacts, type SnapshotControls } from "./ctx-capture.js";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";

/**
 * Decides WHEN the chip row may be written.
 *
 * The `agent.session_open` hook runs before the daemon commits the agent to
 * agent-manager — measured at ~770ms before "Created agent" in the QC round-8
 * daemon log — so `timeline.append` there fails with "Unknown agent" and the row
 * is lost. `agent.created` is the post-commit signal, so a `create` stages its
 * row and flushes it from that event.
 *
 * The `reason` field makes the decision deterministic rather than a guess:
 * `create` is the only pre-commit case, and every other reason (resume, refresh,
 * import) means the agent already exists and can be written immediately. That is
 * why this is not a retry loop: a retry budget would spend its attempts on the
 * cases that already succeed, and the ones it saves are bounded only by how long
 * the daemon happens to take to commit.
 */

export interface StagedChip {
  agentId: string;
  facts: ConfigFacts | null;
  provider: string;
  reason: string;
  purpose: string;
}

/** Host operations the queue needs, injected so the ordering is testable. */
export interface ChipSink {
  /**
   * Read the agent's model/mode and Paseo's tool flag, then assemble the row.
   * Called at flush time, never at session-open time, so the snapshot read sees a
   * committed agent.
   */
  buildData(staged: StagedChip): Promise<CtxInjectChipData>;
  append(agentId: string, data: CtxInjectChipData): Promise<void>;
  /** Failures are always reported; a dropped chip row must never be silent. */
  onError(agentId: string, stage: "append" | "build", error: unknown): void;
}

/** Unbound create facts older than this are dropped rather than misattributed. */
const PENDING_TTL_MS = 60_000;
/** A staged row whose agent never materialises is dropped after this. */
const STAGED_TTL_MS = 120_000;
/** Backstop against an unbounded map if many creations fail to commit. */
const STAGED_MAX = 256;

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
   * Stage 2. For a `create` the row is parked until `agent.created`; otherwise
   * the agent is already committed and the row is written straight away.
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

  /** Builds and writes the row. A refresh may reuse the last facts we observed. */
  private async flush(agentId: string, staged: StagedChip, sink: ChipSink): Promise<void> {
    let data: CtxInjectChipData;
    try {
      data = await sink.buildData(staged);
    } catch (error) {
      sink.onError(agentId, "build", error);
      return;
    }
    try {
      await sink.append(agentId, data);
    } catch (error) {
      sink.onError(agentId, "append", error);
    }
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
