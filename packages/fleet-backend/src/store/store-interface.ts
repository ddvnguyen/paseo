/**
 * Store interface — every domain/tools module codes against this, never
 * against the Turso driver. store/turso-repository.ts is the ONLY file in
 * this package importing @tursodatabase/database (CI-gated).
 */
import type {
  Decision,
  FleetEvent,
  Project,
  QueueItem,
  SuggestionRecord,
  ModelEvaluation,
  Telemetry,
  Track,
  TurnDelta,
  WorkerEvaluation,
  WorkerRecord,
} from "../domain/models.js";

export class StateError extends Error {}

export interface RowFilter {
  types: Set<string> | null;
  trackIds: Set<string> | null;
  includeNullTrack: boolean;
  since: string | null;
}

/**
 * Team domain rows (LLM-Agents-Orchestration#70). Shapes are the DDL columns
 * verbatim: `first_mate` is a SQLite boolean, `ended_at === null` is a live
 * seat session.
 */
export interface TeamRow {
  id: string;
  name: string;
  mission: string;
  created_at: string;
}

export interface SeatRow {
  team_id: string;
  seat: string;
  role: string;
  tier: string;
  first_mate: number;
  persona_md: string;
}

export interface SeatSessionRow {
  team_id: string;
  seat: string;
  agent_id: string;
  model: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string;
}

/**
 * Room message row (#70 T1). Shapes are the DDL columns verbatim:
 * `mentions` / `artifact_refs` are JSON-encoded arrays in storage and parsed
 * arrays on the way out; `discarded_at === null` is a live message.
 */
export interface RoomMessageRow {
  id: string;
  team_id: string;
  ts: string;
  author_seat: string;
  author_agent: string;
  kind: string;
  task_id: string;
  attempt_id: string;
  thread_root: string;
  mentions: string[];
  body: string;
  artifact_refs: string[];
  correlation_id: string;
  discarded_at: string | null;
}

export interface RoomReadOptions {
  sinceId?: string;
  sinceTs?: string;
  limit?: number;
  seat?: string;
  taskId?: string;
  kind?: string;
  includeDiscarded?: boolean;
}

/**
 * Task attempt row (#70 T2). Shapes are the DDL columns verbatim: `evidence`
 * is a JSON-encoded object in storage; `decided_at === null` means no
 * verifier has decided this attempt yet.
 *
 * The evidence shape ({acceptanceResults, commandsRun, changedPaths}) follows
 * dsh-agent-teams src/types.ts (AcceptanceResult, CommandResult,
 * TaskEvidence — MIT, idea only, no code copied).
 */
export type TaskAttemptStatus = "started" | "delivered" | "verified" | "rejected" | "superseded";

export interface AcceptanceResult {
  criterion: string;
  status: "passed" | "failed";
  evidence?: string;
}

export interface CommandResult {
  command: string;
  status: "passed" | "failed";
  exitCode?: number;
  evidence?: string;
}

export interface TaskAttemptRow {
  attempt_id: string;
  team_id: string;
  task_id: string;
  attempt_no: number;
  seat: string;
  agent_id: string;
  status: TaskAttemptStatus;
  /** JSON-encoded evidence object ({acceptanceResults, commandsRun, changedPaths}). */
  evidence: string;
  verifier_seat: string;
  verifier_agent: string;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

export function makeRowFilter(init?: Partial<RowFilter>): RowFilter {
  return {
    types: init?.types ?? null,
    trackIds: init?.trackIds ?? null,
    includeNullTrack: init?.includeNullTrack ?? false,
    since: init?.since ?? null,
  };
}

/** JSON-mode predicate shared by backends (store.RowFilter.matches verbatim). */
export function rowMatches(filter: RowFilter, row: Record<string, unknown>): boolean {
  if (filter.types !== null && !filter.types.has(row["type"] as string)) return false;
  if (filter.trackIds !== null) {
    const trackId = row["track_id"];
    if (!filter.trackIds.has(trackId as string) && !(filter.includeNullTrack && trackId === null))
      return false;
  }
  if (filter.since && ((row["ts"] as string) || "") < filter.since) return false;
  return true;
}

export interface Store {
  readonly root: string;
  /** Advisory exclusive critical section (serializes read-modify-write). */
  lock<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Atomic JSON file write (used for sidecar files even in SQL mode). */
  writeJsonAtomic(filePath: string, data: unknown): Promise<void>;
  projectFile(projectId: string): string;

  // -- projects --
  createProject(
    name: string,
    repos?: Record<string, unknown>[] | string[] | null,
    harness?: string,
    system?: boolean,
  ): Promise<Project>;
  getProject(projectId: string): Promise<Project>;
  findProjectBySlug(slug: string): Promise<Project | null>;
  findSystemProject(slug: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;

  // -- tracks --
  createTrack(
    projectId: string,
    epic: string,
    goal: string,
    repo?: string,
    branch?: string,
  ): Promise<Track>;
  saveTrack(track: Track): Promise<void>;
  getTrack(trackId: string): Promise<Track>;
  listTracks(projectId?: string | null): Promise<Track[]>;

  // -- events / decisions / turns --
  appendEvent(event: FleetEvent, projectId: string): Promise<void>;
  readEvents(projectId: string): Promise<Record<string, unknown>[]>;
  appendDecision(decision: Decision, projectId: string): Promise<void>;
  readDecisions(projectId: string): Promise<Record<string, unknown>[]>;
  nextTurnNumber(projectId: string, trackId: string): Promise<number>;
  saveTurn(projectId: string, trackId: string, delta: TurnDelta): Promise<void>;
  readTurns(projectId: string, trackId: string): Promise<Record<string, unknown>[]>;
  tailEvents(
    projectId: string,
    limit: number,
    offset: number,
    filter: RowFilter | null,
  ): Promise<Record<string, unknown>[]>;
  tailDecisions(
    projectId: string,
    limit: number,
    offset: number,
    filter: RowFilter | null,
  ): Promise<Record<string, unknown>[]>;
  streamDecisions(projectId: string, filter: RowFilter | null): Promise<Record<string, unknown>[]>;
  resolveTurnNumberAt(projectId: string, trackId: string, since: string): Promise<number | null>;
  readTurnsPaged(
    projectId: string,
    trackId: string,
    limit: number,
    offset: number,
    since?: string | null,
  ): Promise<Record<string, unknown>[]>;
  eventsBytes(projectId: string): Promise<number>;
  decisionsBytes(projectId: string): Promise<number>;

  // -- suggestions / model evaluations --
  readSuggestions(projectId: string): Promise<Record<string, unknown>[]>;
  writeSuggestions(projectId: string, suggestions: Record<string, unknown>[]): Promise<void>;
  readModelEvaluations(projectId: string): Promise<Record<string, unknown>[]>;
  writeModelEvaluations(projectId: string, evaluations: Record<string, unknown>[]): Promise<void>;

  // -- team domain (#70) --
  /**
   * Insert a team and its seats in one transaction. The caller owns the
   * first_mate derivation; this layer never guesses it.
   */
  createTeam(team: TeamRow, seats: SeatRow[]): Promise<void>;
  getTeam(teamId: string): Promise<TeamRow | null>;
  listTeams(): Promise<TeamRow[]>;
  addTeamTrack(teamId: string, trackId: string): Promise<void>;
  listTeamTracks(teamId: string): Promise<string[]>;
  listSeats(teamId: string): Promise<SeatRow[]>;
  getSeat(teamId: string, seat: string): Promise<SeatRow | null>;
  /**
   * Record a seat session and close any live session it supersedes.
   * `exclusiveSeats` decides the cardinality: a first-mate seat holds at most
   * one live row, a pooled worker seat may hold many (#70 G4).
   */
  startSeatSession(session: SeatSessionRow, exclusive: boolean): Promise<void>;
  listLiveSeatSessions(teamId: string): Promise<SeatSessionRow[]>;
  listLiveSeatSessionsForSeat(seat: string): Promise<SeatSessionRow[]>;
  /** The live session binding an agent to a seat on a team, if any. */
  findLiveSeatSession(teamId: string, agentId: string): Promise<SeatSessionRow | null>;
  /** Close an agent's live session; posting afterwards is rejected. */
  endSeatSession(teamId: string, agentId: string, endedAt: string, reason: string): Promise<void>;

  // -- team room (#70 T1) --
  /**
   * Insert one room message. The author columns are already derived by the
   * caller (seat sessions for agents, the bearer token for the owner UI) —
   * this layer never guesses them.
   */
  postRoomMessage(message: RoomMessageRow): Promise<void>;
  getRoomMessage(messageId: string): Promise<RoomMessageRow | null>;
  /**
   * Ascending (oldest first) read, pageable via sinceId/sinceTs. Discarded
   * messages are excluded unless includeDiscarded is set. An unknown sinceId
   * throws StateError rather than silently returning the whole room.
   */
  listRoomMessages(teamId: string, options?: RoomReadOptions): Promise<RoomMessageRow[]>;
  /**
   * Mark a message obsolete (the ONLY update room_messages allows, enforced
   * by trigger). Returns false when the id is unknown or already discarded.
   */
  discardRoomMessage(messageId: string, discardedAt: string): Promise<boolean>;

  // -- task attempts (#70 T2) --
  /**
   * Append one attempt row. attempt_no allocation and superseding are the
   * caller's job (inside lock); this layer stores the row verbatim.
   */
  createTaskAttempt(attempt: TaskAttemptRow): Promise<void>;
  /** Fetch an attempt by its opaque token, or null when unknown. */
  getTaskAttempt(attemptId: string): Promise<TaskAttemptRow | null>;
  /** Every attempt of a task, oldest first (attempt_no ascending). */
  listTaskAttempts(teamId: string, taskId: string): Promise<TaskAttemptRow[]>;
  /** The latest attempt of a task (highest attempt_no), or null when none. */
  getCurrentTaskAttempt(teamId: string, taskId: string): Promise<TaskAttemptRow | null>;
  /**
   * Mark every live (started|delivered) prior attempt of a task superseded,
   * except the named one. Terminal verdicts (verified|rejected) are history
   * and are never rewritten. Returns the superseded count.
   */
  supersedePriorAttempts(
    teamId: string,
    taskId: string,
    exceptAttemptId: string,
    at: string,
  ): Promise<number>;
  /**
   * Move a started attempt to delivered. Returns false when the attempt is
   * unknown or no longer started (stale token, superseded, already decided).
   */
  markAttemptDelivered(attemptId: string, evidence: string, at: string): Promise<boolean>;
  /**
   * Decide a delivered attempt (verified|rejected), recording the verifier.
   * Returns false when the attempt is unknown or no longer delivered.
   */
  decideAttempt(
    attemptId: string,
    verdict: "verified" | "rejected",
    evidence: string,
    verifierSeat: string,
    verifierAgent: string,
    at: string,
  ): Promise<boolean>;
}

export type {
  Decision,
  FleetEvent,
  Project,
  QueueItem,
  SuggestionRecord,
  ModelEvaluation,
  Telemetry,
  Track,
  TurnDelta,
  WorkerEvaluation,
  WorkerRecord,
};
