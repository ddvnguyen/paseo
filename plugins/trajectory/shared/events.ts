import { z } from "zod";

/**
 * Trajectory ledger envelope. Every observable agent fact is one append-only
 * row. `seq` is the global order authority (unique, monotonic); `time` is the
 * recorder's ISO-8601 timestamp.
 */
export const TrajectoryEventSchema = z.object({
  /** Global monotonic sequence; insertion-order and pagination key. */
  seq: z.number().int().nonnegative(),
  /** ISO-8601 timestamp assigned by the recorder at append time. */
  time: z.string(),
  /** Dot-namespaced event type, e.g. `turn.started` / `tool.completed`. */
  type: z.string(),
  /** Turn correlation id; null for rows outside any turn. */
  turn: z.string().nullable(),
  /** Step index within the turn; null when the provider does not report steps. */
  step: z.number().int().nonnegative().nullable(),
  agentId: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
});

export type TrajectoryEvent = z.infer<typeof TrajectoryEventSchema>;
