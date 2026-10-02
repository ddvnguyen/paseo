/**
 * Shared trajectory record data and formatting contracts.
 *
 * Ported from DeepSeek deepseek-harness `packages/client/ui-trajectory/src/client/trajectory-record.ts`
 * (llm-server-monitoring repo, commit afd92680f2, MIT License — Copyright (c) 2026 DeepSeek).
 * Changes from upstream: the `HTMLAttributes<HTMLDivElement>` react-dom base is
 * stripped (React Native, no DOM attributes); `ConversationPromptSnapshot` is
 * replaced by a structural local type; everything else is kept in sync with
 * upstream so future ports stay mechanical.
 */

/** Closed set of trajectory record kinds. */
export type TrajectoryCellKind =
  | "system"
  | "user"
  | "context"
  | "compacted"
  | "message"
  | "tool"
  | "subtool"
  /**
   * A derived LLM round: tool results were handed to a model, which then chose
   * the next action. No provider emits this event, so the recorder infers it —
   * see the recorder's round-marker rule for why the inference is sound.
   */
  | "llm"
  /**
   * The caller system prompt, as size and hash only. Never the text; the
   * ledger is length-only by rule.
   */
  | "systemPrompt"
  /** Provider reasoning/thinking text, length only. */
  | "thinking";

/** Recorded inputs needed to derive assistant TTFT and decode throughput. */
export interface AssistantMetricDetail {
  timingRecorded: boolean;
  stepStartTime: number | null;
  firstTokenTime: number | null;
  completedTime: number | null;
  usageProvided: boolean;
  outputTokens: number | null;
}

/** One source content block preserved in model order for the details panel. */
export interface TrajectorySourceBlock {
  type: string;
  content: string;
  imageSrc?: string;
  imageAlt?: string;
  callId?: string;
  toolName?: string;
}

/** Structural replacement for dsh `ConversationPromptSnapshot` (observer-only). */
export interface PromptSnapshotDetail {
  systemPromptLength?: number | null;
  tools?: readonly string[];
  [key: string]: unknown;
}

/** Data for one trajectory record. React Native: presentation is the renderer's job. */
export interface TrajectoryCellProps {
  /** 1-based record index shown as `#N`. */
  index: number;
  /** Projection-stable identity when no single source event owns the record lifecycle. */
  recordId?: string;
  kind: TrajectoryCellKind;
  /** Non-Markdown summary or prefix; single-line ellipsis when it overflows. */
  text: string;
  /** Raw Markdown source converted into the single-line summary at its consumer. */
  previewMarkdown?: string;
  /** Whether this user record opens a new model turn. */
  opensTurn?: boolean;
  /** Source session-event seq for cross-record navigation. */
  sourceSeq?: number;
  /**
   * Identity of the daemon timeline item this record came from, when the
   * producer reported one. A foreign key, never content: the recorder stores it
   * so the client can fetch this record's text on demand without the ledger ever
   * holding the text. Absent on rows recorded before this existed, and absent
   * when the producer sent no id — such rows keep their length label.
   */
  sourceMessageId?: string | null;
  /** Producer role and name from a user-role message or context injection. */
  messageSource?: unknown;
  /** A separator-only anchor for an auxiliary request with no visible record. */
  requestOnly?: boolean;
  /** Full request/message content for the details panel. */
  inputDetail?: string;
  /** Complete system-prompt/tool-catalog state introduced by a SYSTEM record. */
  promptDetail?: PromptSnapshotDetail;
  /** System-prompt/tool-catalog state replaced by a SYSTEM update. */
  previousPromptDetail?: PromptSnapshotDetail;
  /** Full assistant/tool result content for the details panel. */
  outputDetail?: string;
  /** Full assistant reasoning content for the details panel. */
  thinkingDetail?: string;
  /** Original message blocks in source order for the details panel. */
  sourceBlocks?: readonly TrajectorySourceBlock[];
  /** Original tool result blocks in source order for the details panel. */
  outputBlocks?: readonly TrajectorySourceBlock[];
  /** Call-time model-visible tool schema for the details panel. */
  schemaDetail?: string;
  /** Assistant-only timing and token facts for the details panel. */
  assistantMetrics?: AssistantMetricDetail;
  /** Tool-only result summary paired with the call in the same record. */
  result?: string;
  /** Raw Markdown source converted into the tool-result summary at its consumer. */
  resultPreviewMarkdown?: string;
  /** Tool call id used to link message source blocks to tool records. */
  callId?: string;
  /**
   * Message total-so-far and the slice THIS record contributed. The daemon
   * re-emits one assistant message across many stream chunks, so a record
   * carries its own delta rather than the whole message. Absent when the length
   * is unknown or the record has no source identity.
   */
  textLength?: number;
  deltaChars?: number;
  /** Offset into the message text at which this record's delta starts. */
  deltaStart?: number;
  /**
   * Every source message id folded into this record, in seq order. A merged
   * response row spans several; a single-segment row has exactly one. Used to
   * fetch and compose the text for the detail view.
   */
  sourceMessageIds?: string[];
  /** How many stream events this record merged; 1 when it is a single row. */
  segments?: number;
  /** Tool-only result failure state. */
  isError?: boolean;
  /** Own duration in seconds, or `null` when no duration is known. */
  timeSeconds: number | null;
  /** Unix epoch milliseconds when this operation actually started, when known. */
  startedAt?: number | null;
  /** Message-only prompt token count. */
  input?: number;
  /** Message-only input tokens served from a provider cache. */
  cacheRead?: number;
  /** Message-only input tokens written into a provider cache. */
  cacheWrite?: number;
  /** Message-only completion token count. */
  output?: number;
  /** Message-only reasoning token count. */
  think?: number;
  /** Whether the cell renders its selection treatment. */
  selected?: boolean;
}

/**
 * Resolve the identity that survives prepending older projected records.
 * @param cell - Projected trajectory record.
 * @returns Stable identity from the owning event or tool call, with a fixture fallback.
 */
export function trajectoryRecordId(cell: TrajectoryCellProps): string {
  if (cell.recordId !== undefined) return cell.recordId;
  if (cell.callId !== undefined) return `${cell.kind}\u0000call\u0000${cell.callId}`;
  if (cell.sourceSeq !== undefined) return `${cell.kind}\u0000seq\u0000${cell.sourceSeq}`;
  return `${cell.kind}\u0000index\u0000${cell.index}`;
}

/** Boundaries between the three duration tiers. */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/**
 * Format a duration the way a reader scans one.
 *
 * Three tiers: raw milliseconds under a second, whole seconds under a minute,
 * minutes and seconds above that. `32,000 ms` is noise in a narrow column and
 * `3m45s` is not something the eye parses as "225000" — the label has to be
 * short enough to sit in a fixed column and unambiguous enough to compare down
 * a list of rows.
 *
 * Every tier FLOORS to its own unit, so a label never claims time the row did
 * not take: 32,400ms reads "32s", not "33s". Flooring also means a row sitting
 * just under a boundary (59.9s) does not round itself up past it and report a
 * duration it has not reached yet.
 *
 * There is no hour tier, so an hour-long call reads "60m0s". Two tiers were the
 * ask; add hours if real sessions produce one.
 *
 * @param milliseconds - Duration in milliseconds, or `null` when absent.
 * @returns `—` when unknown or not a real duration, otherwise the tier's label.
 */
export function formatDurationMillis(milliseconds: number | null): string {
  // A negative duration is not a short one, and rendering it as one would put a
  // signed number in a column of unsigned ones; unknown is the honest label.
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < MS_PER_SECOND) return `${Math.floor(milliseconds)} ms`;
  const totalSeconds = Math.floor(milliseconds / MS_PER_SECOND);
  if (totalSeconds < SECONDS_PER_MINUTE) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / SECONDS_PER_MINUTE)}m${totalSeconds % SECONDS_PER_MINUTE}s`;
}

/**
 * Format an elapsed duration given in seconds, through the shared millisecond
 * formatter — one set of tiers for every duration in the ledger.
 * @param seconds - Duration seconds, or `null` when absent.
 * @returns `—` when unknown, otherwise the same label a millisecond value gets.
 */
export function formatElapsedSeconds(seconds: number | null): string {
  return formatDurationMillis(seconds === null ? null : seconds * MS_PER_SECOND);
}
