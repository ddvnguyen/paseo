import { z } from "zod";

/**
 * Wire contract for trajectory reads. Mirrors the dsh trajectory vocabulary:
 * cell kinds system/user/message/tool, per-row own duration, usage buckets
 * input/cacheRead/cacheWrite/output/think. Observer-only: anything a provider
 * does not report is null and renders as "—" (no TTFT, no chunk clocks).
 */

export const TRAJECTORY_EVENT_TYPES = [
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "assistant/message",
  "user/message",
  "tool/call",
  "tool/result",
  // Derived by the recorder, never received from a provider: no real LLM-round
  // event reaches plugins (the opencode step-start is dropped upstream and
  // usage_updated is not in the wire union), so the recorder infers the round
  // boundary from the one signal every provider does emit -- an action arriving
  // after tool results. `data.derived` is always true on these rows.
  "round/begin",
  // Derived from `before("agent.create")`'s caller systemPrompt. Length and a
  // short hash only; the prompt text is never stored (d-893c722f28).
  "system/attach",
  // A provider's reasoning/thinking text. This one is OBSERVED, not derived:
  // `reasoning` is a member of the AgentTimelineItem union (protocol
  // agent-types.ts:374) and opencode translates its reasoning parts into real
  // timeline events (providers/opencode-agent.ts:2787, :2918), so the recorder
  // sees them. Length only, like every other message row.
  "thinking/message",
] as const;

export type TrajectoryEventType = (typeof TRAJECTORY_EVENT_TYPES)[number];

/** Envelope as stored in the ledger (seq is DB-assigned). */
export const TrajectoryEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  time: z.string(), // ISO-8601
  type: z.string(),
  turn: z.string().nullable(),
  step: z.number().int().nonnegative().nullable(),
  agentId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
});

export type TrajectoryEvent = z.infer<typeof TrajectoryEventSchema>;

/** Page size applied when a caller omits `limit`; mirrors the zod default. */
export const TRAJECTORY_PAGE_LIMIT_DEFAULT = 500;

/**
 * Page contract, shared by every read below.
 *
 * Rows always come back ASCENDING by `seq`. That is part of the contract, not
 * an implementation detail — the client fold walks events in arrival order and
 * never sorts, and a newest-first page mis-pairs `tool/call` with
 * `tool/result`.
 *
 * WHICH rows come back is per-RPC, because the two directions want opposite
 * ends of the window:
 *
 * - `list` takes the NEWEST rows matching the bounds. It is the initial open,
 *   and a live ledger is watched at its head.
 * - `changes` takes the OLDEST rows above `afterSeq`, so the forward drain
 *   steps from the cursor one page at a time. Taking the newest instead
 *   consumes a backlog larger than a page from the end and strands its middle.
 * - `subscribe` is payload-identical to `changes`, so it matches `changes`.
 *
 * `beforeSeq` is the reverse cursor, exclusive: it is what makes history older
 * than one page reachable. No shipped client sends it yet.
 *
 * `headSeq` is the page's own last `seq`. It is deliberately NOT the agent's
 * global `MAX(seq)`, which can name rows that were never sent (anything written
 * between the page query and a separate max query) and would put them out of
 * reach of every later `seq > afterSeq` poll.
 *
 * For a FORWARD page — anything without `beforeSeq`, which is every page a
 * client reads today — `headSeq` is the cursor to send as `afterSeq` next. It is
 * NOT that for a reverse page: a reverse page's last seq is its oldest row, and
 * adopting it as the forward cursor would rewind past rows the caller already
 * holds and re-deliver them. A caller paging backwards keeps its own forward
 * cursor.
 */

export const trajectoryList = defineTrajectoryRpc({
  name: "trajectory.list",
  input: z.object({
    agentId: z.string().min(1),
    afterSeq: z.number().int().nonnegative().optional(),
    // COMPAT(trajectoryBeforeSeq): added in plugin 0.1.1, remove after 2027-03-28
    // once no shipped client pages backwards. Optional, so a client that never
    // sends it keeps working against a daemon that ignores it.
    beforeSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(1000).default(TRAJECTORY_PAGE_LIMIT_DEFAULT),
  }),
  output: z.object({
    events: z.array(TrajectoryEventSchema),
    /**
     * Seq of the newest row IN THIS PAGE. Send it as the next `afterSeq` —
     * unless this response was a `beforeSeq` (reverse) page, where the caller
     * keeps its own forward cursor instead. See the page contract above.
     */
    headSeq: z.number().int().nonnegative(),
  }),
});

/** Delta poll body for push updates (client long-polls with afterSeq). */
export const trajectoryChanges = defineTrajectoryRpc({
  name: "trajectory.changes",
  input: z.object({
    agentId: z.string().min(1),
    afterSeq: z.number().int().nonnegative(),
    // COMPAT(trajectoryBeforeSeq): added in plugin 0.1.1, remove after 2027-03-28
    // once no shipped client pages backwards. Optional, so a client that never
    // sends it keeps working against a daemon that ignores it.
    beforeSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(1000).default(200),
  }),
  output: z.object({
    events: z.array(TrajectoryEventSchema),
    headSeq: z.number().int().nonnegative(),
  }),
});

/**
 * Push seam (reserved). The plugin client API has no server-push primitive,
 * so today the client drives `list` once and re-fires `changes` on settle;
 * the payload shape is intentionally identical to `changes` so a future push
 * transport slots in without touching the fold. The server handler currently
 * delegates to the same paged read; the live fan-out point is the recorder's
 * onAppend hub (server/wiring.ts), not this RPC.
 */
export const trajectorySubscribe = defineTrajectoryRpc({
  name: "trajectory.subscribe",
  input: z.object({
    agentId: z.string().min(1),
    afterSeq: z.number().int().nonnegative(),
    // COMPAT(trajectoryBeforeSeq): added in plugin 0.1.1, remove after 2027-03-28
    // once no shipped client pages backwards. Optional, so a client that never
    // sends it keeps working against a daemon that ignores it.
    beforeSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(1000).default(200),
  }),
  output: z.object({
    events: z.array(TrajectoryEventSchema),
    headSeq: z.number().int().nonnegative(),
  }),
});

function defineTrajectoryRpc<Input extends z.ZodType, Output extends z.ZodType>(definition: {
  name: string;
  input: Input;
  output: Output;
}) {
  return definition;
}

// ---------------------------------------------------------------------------
// Snapshot: the pure fold target the UI renders
// ---------------------------------------------------------------------------

export const TrajectoryUsageSchema = z.object({
  input: z.number().nullable(),
  cacheRead: z.number().nullable(),
  cacheWrite: z.number().nullable(),
  output: z.number().nullable(),
  think: z.number().nullable(),
});

export type TrajectoryUsage = z.infer<typeof TrajectoryUsageSchema>;

export const TrajectoryCellKindSchema = z.enum(["system", "user", "message", "tool"]);
export type TrajectoryCellKind = z.infer<typeof TrajectoryCellKindSchema>;

/** One ledger row folded into a renderable cell. Times are own-duration ms. */
export const TrajectoryCellSchema = z.object({
  kind: TrajectoryCellKindSchema,
  /** Text/args preview (tool rows: `name · args`), truncated by the fold. */
  label: z.string(),
  /** Own duration ms (call->result, or step start->end); null = in-flight/unknown -> "—". */
  durationMs: z.number().nullable(),
  /** Message rows: token buckets; null when the provider did not report. */
  usage: TrajectoryUsageSchema.nullable(),
  /** Tool rows: output character count; null when unknown. */
  outputChars: z.number().nullable(),
  isError: z.boolean().nullable(),
  /** Seq of the row that produced this cell (dedupe/inspector key). */
  seq: z.number().int().nonnegative(),
  /** All event seqs folded into this cell (call+result for tool rows). */
  seqs: z.array(z.number().int().nonnegative()),
});

export type TrajectoryCell = z.infer<typeof TrajectoryCellSchema>;

export const TrajectoryStepSchema = z.object({
  /** 1-based step number within the turn; null when the provider reports no steps. */
  step: z.number().int().nonnegative().nullable(),
  message: TrajectoryCellSchema.nullable(),
  tools: z.array(TrajectoryCellSchema),
});

export type TrajectoryStep = z.infer<typeof TrajectoryStepSchema>;

export const TrajectoryTurnSchema = z.object({
  /** Turn id string from the ledger (UI numbers turns by position). */
  turnId: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  outcome: z.enum(["completed", "failed", "canceled", "in-flight"]),
  error: z.string().nullable(),
  usage: TrajectoryUsageSchema.nullable(),
  steps: z.array(TrajectoryStepSchema),
  /** User rows that arrived inside this turn (dsh folds users into turns). */
  users: z.array(TrajectoryCellSchema),
});

export type TrajectoryTurn = z.infer<typeof TrajectoryTurnSchema>;

export const TrajectorySnapshotSchema = z.object({
  agentId: z.string(),
  /** Highest seq folded in (cursor for incremental refresh). */
  headSeq: z.number().int().nonnegative(),
  turns: z.array(TrajectoryTurnSchema),
  /** Rows that arrived with turn=null and no open turn (leading user rows). */
  orphans: z.array(TrajectoryCellSchema),
});

export type TrajectorySnapshot = z.infer<typeof TrajectorySnapshotSchema>;
