import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { CtxInjectChipData } from "../shared/ctx-schema.js";
import { configFacts, type ConfigFacts, type SnapshotControls } from "./ctx-capture.js";

/**
 * Decides WHEN the chip row may be written.
 *
 * The daemon commits an agent to agent-manager after the hooks run, and until it
 * does, `timeline.append` is rejected with "Unknown agent". Three rounds of QC
 * shaped this, and the rule they add up to is narrow:
 *
 *   The append's own rejection is the ONLY ground truth for "is this agent
 *   committable". Never pre-check it.
 *
 * - Round 8, a fresh create: `agent.session_open` is pre-commit, so the append
 *   failed and the row was lost. A create now parks its row until
 *   `agent.created`, the post-commit signal.
 * - Round 9, a resume: the agent is in the store but not yet committed, so the
 *   inline write was rejected. There is no event for "now committed" —
 *   `agent.created` explicitly excludes resume — so this path retries.
 * - Round 10, a regression I introduced: the retry was gated behind
 *   `ref().current() != null`, a LIVE SESSION HANDLE. That is strictly stronger
 *   than the map commit the append needs, so on a slow or failing provider setup
 *   the gate never opened and the append was never attempted at all. The chip
 *   vanished. A gate stricter than the operation it guards is a bug, not caution.
 *
 * So there is no liveness precondition here. `buildData` runs, `append` is
 * attempted, and only an "Unknown agent" rejection buys another attempt.
 *
 * Model and mode need no read at all on the create path: they come from the
 * create config. A session that never ran the create hook has no such facts, so
 * its controls are read only AFTER an append has succeeded — at that point the
 * commit is proven, and re-appending the same row id replaces it in place.
 */

/** Unbound create facts older than this are dropped rather than misattributed. */
const PENDING_TTL_MS = 60_000;
/** A staged row whose agent never materialises is dropped after this. */
const STAGED_TTL_MS = 120_000;
/** Backstop against an unbounded map if many creations fail to commit. */
const STAGED_MAX = 256;

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
   * Assemble the row. `controls` is null on the first write and only supplied on
   * the refinement pass that runs after an append has proven the commit.
   */
  buildData(staged: StagedChip, controls: SnapshotControls | null): Promise<CtxInjectChipData>;
  append(agentId: string, data: CtxInjectChipData): Promise<void>;
  /**
   * Best-effort model/mode for a session that never ran the create hook. Only
   * ever called after a successful append. Returns null when unavailable.
   */
  readControls(agentId: string): SnapshotControls | null;
  /** Failures are always reported; a dropped chip row must never be silent. */
  onError(agentId: string, stage: "append" | "build", error: unknown): void;
}

export interface RetryPolicy {
  /** Total attempts, including the first. */
  attempts: number;
  /** Delay before attempt n+1, indexed from 0. */
  backoffMs: number[];
}

/**
 * Generous on purpose. A 403-disabled or slow provider can take many seconds to
 * register, and round 10 showed a ~1.7s budget losing the row outright. The flush
 * is fire-and-forget from the hook, so a long budget never delays a session open.
 */
export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 8,
  // ~15.75s total.
  backoffMs: [250, 500, 1000, 2000, 3000, 4000, 5000],
};

/**
 * The rejection the daemon returns while an agent is in the store but not yet
 * committed: "Request failed: Unknown agent '<id>' ... code=handler_error".
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
   * inline, because the agent already exists in the store and only needs to
   * become committed.
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
   * Write the row, then — only if the first write lacked model/mode — read the
   * controls and rewrite in place. The append is both the action and the proof:
   * there is no separate liveness check to disagree with it.
   */
  private async flush(agentId: string, staged: StagedChip, sink: ChipSink): Promise<void> {
    const data = await this.build(staged, null, sink);
    if (!data) return;
    if (!(await this.appendWithRetry(agentId, data, sink))) return;

    // Proven committed. Only now is a controls read meaningful, and only for a
    // session that never ran the create hook.
    if (data.model !== null && data.modeId !== null) return;
    const controls = safeReadControls(sink, agentId);
    if (!controls) return;
    if (controls.model === null && controls.currentModeId === null) return;

    const refined = await this.build(staged, controls, sink);
    if (!refined) return;
    if (refined.model === data.model && refined.modeId === data.modeId) return;

    // Same row id, so this replaces the row rather than adding a second one.
    await this.appendWithRetry(agentId, refined, sink);
  }

  private async build(
    staged: StagedChip,
    controls: SnapshotControls | null,
    sink: ChipSink,
  ): Promise<CtxInjectChipData | null> {
    try {
      return await sink.buildData(staged, controls);
    } catch (error) {
      sink.onError(staged.agentId, "build", error);
      return null;
    }
  }

  /** Returns true when a write landed; false when the budget was exhausted. */
  private async appendWithRetry(
    agentId: string,
    data: CtxInjectChipData,
    sink: ChipSink,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.retry.attempts; attempt += 1) {
      const isLast = attempt === this.retry.attempts - 1;
      try {
        await sink.append(agentId, data);
        return true;
      } catch (error) {
        // Only "not committed yet" is worth another attempt. Anything else is a
        // real fault, and retrying it would only delay the report.
        if (isLast || !isNotAvailable(error)) {
          sink.onError(agentId, "append", error);
          return false;
        }
        await this.sleep(this.backoffFor(attempt));
      }
    }
    return false;
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

/** A controls read is best effort: a failure is just "unknown", never an error. */
function safeReadControls(sink: ChipSink, agentId: string): SnapshotControls | null {
  try {
    return sink.readControls(agentId);
  } catch {
    return null;
  }
}

export type { ConfigFacts, SnapshotControls };
