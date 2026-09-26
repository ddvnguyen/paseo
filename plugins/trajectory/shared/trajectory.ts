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

/** Paged read. `afterSeq` is the cursor; rows return ascending by seq. */
export const trajectoryList = defineTrajectoryRpc({
  name: "trajectory.list",
  input: z.object({
    agentId: z.string().min(1),
    afterSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(1000).default(500),
  }),
  output: z.object({
    events: z.array(TrajectoryEventSchema),
    /** Seq of the newest row for this agent; use as the next afterSeq cursor. */
    headSeq: z.number().int().nonnegative(),
  }),
});

/** Delta poll body for push updates (client long-polls with afterSeq). */
export const trajectoryChanges = defineTrajectoryRpc({
  name: "trajectory.changes",
  input: z.object({
    agentId: z.string().min(1),
    afterSeq: z.number().int().nonnegative(),
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
