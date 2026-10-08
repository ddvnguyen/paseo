/**
 * Room domain tool — LLM-Agents-Orchestration#70 T1 (Team Room v1).
 *
 * One tool, four actions: post | read | subscribe | discard. Registered
 * through the T0 seam (tools/registry.ts) as its own domain; TEAM_DOMAIN is
 * untouched (its import-discipline test pins its tool list).
 *
 * SENDER IDENTITY IS DERIVED, NEVER TRUSTED: post/discard resolve the
 * author_seat from the caller's agent_id through the LIVE seat session
 * (seat_sessions, ended_at IS NULL). A caller with no live session — unknown
 * agent, or a session that has ended — is rejected. Client-supplied
 * author_agent/author_seat args are rejected outright, so a forged sender can
 * never reach the store.
 *
 * The owner UI is a SEPARATE path: it is bearer-authenticated over HTTP
 * (surfaces/http/room.ts) and posts with the distinct `owner` author, which
 * the agent path below can never mint (agent_id "owner" has no seat session,
 * and author_* overrides are rejected before resolution).
 *
 * Every post also appends a `room_posted` event (closed vocabulary in
 * domain/models.ts EVENT_TYPES) against the team's first track, so the room
 * stays visible in history. A team with no tracks still posts — the message
 * is the record, the event is best-effort.
 *
 * Import discipline (mirrors src/mcp.ts and tools/team.ts): importing this
 * module must have no side effects. Pure declarations only.
 */
import { newId, utcnowIso } from "../domain/models.js";
import type { RoomMessageRow, SeatSessionRow, Store } from "../store/store-interface.js";
import type { ToolDomain, ToolSpec } from "./registry.js";

/** Message kinds, exactly the #70 T1 vocabulary. */
export const ROOM_KINDS: readonly string[] = [
  "chat",
  "task_assigned",
  "task_progress",
  "task_report",
  "task_verified",
  "task_rejected",
  "approval_request",
  "system",
];

/**
 * The owner UI's author, minted ONLY by the bearer-authenticated HTTP path
 * (surfaces/http/room.ts). It is not a seat, so no agent can hold or forge
 * it through the seat-session resolution below.
 */
export const OWNER_AUTHOR = "owner";

/** Upper bound for a subscribe long-poll; larger wait_ms values are clamped. */
export const MAX_SUBSCRIBE_WAIT_MS = 10_000;

/** How often a long-poll re-reads while waiting for a new message. */
const SUBSCRIBE_POLL_MS = 25;

// ---------------------------------------------------------------------------
// Argument reading — total accessors, mirroring tools/team.ts.
// ---------------------------------------------------------------------------

function str(args: Record<string, unknown>, key: string, dflt = ""): string {
  const v = args[key];
  if (v === null || v === undefined) return dflt;
  const s = String(v).trim();
  return s === "" ? dflt : s;
}

function list(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v)) return [];
  return v.map((item) => String(item).trim()).filter((item) => item !== "");
}

function flag(args: Record<string, unknown>, key: string): boolean {
  const v = args[key];
  return v === true || v === 1 || v === "true" || v === "1";
}

function intArg(args: Record<string, unknown>, key: string, dflt: number): number {
  const v = args[key];
  if (v === null || v === undefined || v === "") return dflt;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

function unknownTeam(teamId: string): Record<string, unknown> {
  return {
    ok: false,
    error: `team not found: ${teamId}`,
    hint: "list teams or create one first with team(action=create)",
  };
}

function noLiveSeat(agentId: string, teamId: string): Record<string, unknown> {
  return {
    ok: false,
    error: `no live seat session for agent ${agentId} on team ${teamId}`,
    hint: "join a seat first with team_join(team, seat, agent_id); an unknown agent, or a session that has ended, cannot post",
  };
}

/** A present-but-forbidden author override: the forgery tripwire. */
function forgedAuthor(args: Record<string, unknown>): string | null {
  for (const key of ["author_agent", "author_seat"]) {
    if (str(args, key) !== "") return key;
  }
  return null;
}

/**
 * Append the `room_posted` event for a message against the team's first
 * track, so the room stays visible in history. Shared by the agent tool and
 * the owner HTTP path — one implementation, no drift. A team with no tracks
 * has no ledger to append to; the message itself is still the record.
 */
export async function appendRoomEvent(
  store: Store,
  message: RoomMessageRow,
): Promise<"appended" | "skipped_no_track" | "skipped_track_error"> {
  const trackIds = await store.listTeamTracks(message.team_id);
  if (trackIds.length === 0) return "skipped_no_track";
  try {
    const track = await store.getTrack(trackIds[0]!);
    await store.appendEvent(
      {
        ts: message.ts,
        type: "room_posted",
        track_id: track.id,
        project_id: track.project_id,
        payload: {
          team_id: message.team_id,
          message_id: message.id,
          seat: message.author_seat,
          kind: message.kind,
          task_id: message.task_id,
        },
      },
      track.project_id,
    );
    return "appended";
  } catch {
    return "skipped_track_error";
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function roomPost(
  store: Store,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const teamId = str(args, "team") || str(args, "team_id");
  if (!teamId) return { ok: false, error: "team is required", hint: "pass the team id" };
  const forged = forgedAuthor(args);
  if (forged !== null) {
    return {
      ok: false,
      error: `${forged} is derived, never caller-supplied`,
      hint: "omit author_agent/author_seat; the seat is resolved from agent_id via its live seat session",
    };
  }
  const agentId = str(args, "agent_id");
  if (!agentId) {
    return { ok: false, error: "agent_id is required", hint: "pass the posting agent id" };
  }
  if (agentId === OWNER_AUTHOR) {
    return {
      ok: false,
      error: `agent_id ${OWNER_AUTHOR} is reserved for the bearer-authenticated owner UI`,
      hint: "agents post with their own agent id; the owner posts over HTTP",
    };
  }
  const body = str(args, "body");
  if (!body) return { ok: false, error: "body is required", hint: "pass the message text" };
  const kind = str(args, "kind", "chat");
  if (!ROOM_KINDS.includes(kind)) {
    return {
      ok: false,
      error: `invalid kind ${JSON.stringify(kind)}`,
      hint: `must be one of: ${ROOM_KINDS.join(", ")}`,
    };
  }
  const team = await store.getTeam(teamId);
  if (!team) return unknownTeam(teamId);
  const session = await store.findLiveSeatSession(team.id, agentId);
  if (!session) return noLiveSeat(agentId, team.id);

  const message: RoomMessageRow = {
    id: str(args, "id") || newId("msg"),
    team_id: team.id,
    ts: utcnowIso(),
    author_seat: (session as SeatSessionRow).seat,
    author_agent: agentId,
    kind,
    task_id: str(args, "task_id"),
    attempt_id: str(args, "attempt_id"),
    thread_root: str(args, "thread_root"),
    mentions: list(args, "mentions"),
    body,
    artifact_refs: list(args, "artifact_refs"),
    correlation_id: str(args, "correlation_id"),
    discarded_at: null,
  };
  await store.postRoomMessage(message);
  const event = await appendRoomEvent(store, message);
  return { ok: true, message, event };
}

interface ReadParams {
  sinceId: string;
  sinceTs: string;
  limit: number;
  seat: string;
  taskId: string;
  kind: string;
  includeDiscarded: boolean;
}

function readParams(args: Record<string, unknown>): ReadParams {
  return {
    sinceId: str(args, "since_id"),
    sinceTs: str(args, "since") || str(args, "since_ts"),
    limit: intArg(args, "limit", 50),
    seat: str(args, "seat"),
    taskId: str(args, "task_id"),
    kind: str(args, "kind"),
    includeDiscarded: flag(args, "include_discarded"),
  };
}

async function roomRead(
  store: Store,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const teamId = str(args, "team") || str(args, "team_id");
  if (!teamId) return { ok: false, error: "team is required", hint: "pass the team id" };
  const team = await store.getTeam(teamId);
  if (!team) return unknownTeam(teamId);
  const params = readParams(args);
  if (params.kind !== "" && !ROOM_KINDS.includes(params.kind)) {
    return {
      ok: false,
      error: `invalid kind ${JSON.stringify(params.kind)}`,
      hint: `must be one of: ${ROOM_KINDS.join(", ")}`,
    };
  }
  let messages: RoomMessageRow[];
  try {
    messages = await store.listRoomMessages(team.id, {
      sinceId: params.sinceId || undefined,
      sinceTs: params.sinceTs || undefined,
      limit: params.limit,
      seat: params.seat || undefined,
      taskId: params.taskId || undefined,
      kind: params.kind || undefined,
      includeDiscarded: params.includeDiscarded,
    });
  } catch (exc) {
    return {
      ok: false,
      error: (exc as Error).message,
      hint: "pass a message id from a previous read as since_id",
    };
  }
  return {
    ok: true,
    team: { id: team.id, name: team.name },
    messages,
    count: messages.length,
    next_since_id: messages.length ? messages[messages.length - 1]!.id : null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function roomSubscribe(
  store: Store,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const waitMs = Math.max(0, Math.min(MAX_SUBSCRIBE_WAIT_MS, intArg(args, "wait_ms", 5000)));
  const started = Date.now();
  const first = await roomRead(store, args);
  if (!first["ok"] || (first["messages"] as unknown[]).length > 0 || waitMs === 0) {
    return { ...first, waited_ms: Date.now() - started, timeout: false };
  }
  for (;;) {
    const remaining = waitMs - (Date.now() - started);
    if (remaining <= 0) break;
    await sleep(Math.min(SUBSCRIBE_POLL_MS, remaining));
    const polled = await roomRead(store, args);
    if (!polled["ok"] || (polled["messages"] as unknown[]).length > 0) {
      return { ...polled, waited_ms: Date.now() - started, timeout: false };
    }
  }
  const drained = await roomRead(store, args);
  return { ...drained, waited_ms: Date.now() - started, timeout: true };
}

async function roomDiscard(
  store: Store,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const teamId = str(args, "team") || str(args, "team_id");
  if (!teamId) return { ok: false, error: "team is required", hint: "pass the team id" };
  const messageId = str(args, "id") || str(args, "message_id");
  if (!messageId) {
    return { ok: false, error: "id is required", hint: "pass the message id to discard" };
  }
  const forged = forgedAuthor(args);
  if (forged !== null) {
    return {
      ok: false,
      error: `${forged} is derived, never caller-supplied`,
      hint: "omit author_agent/author_seat; discarding needs only team, id and agent_id",
    };
  }
  const agentId = str(args, "agent_id");
  if (!agentId) {
    return { ok: false, error: "agent_id is required", hint: "pass the discarding agent id" };
  }
  if (agentId === OWNER_AUTHOR) {
    return {
      ok: false,
      error: `agent_id ${OWNER_AUTHOR} is reserved for the bearer-authenticated owner UI`,
      hint: "agents discard with their own agent id",
    };
  }
  const team = await store.getTeam(teamId);
  if (!team) return unknownTeam(teamId);
  const session = await store.findLiveSeatSession(team.id, agentId);
  if (!session) return noLiveSeat(agentId, team.id);
  const message = await store.getRoomMessage(messageId);
  if (!message || message.team_id !== team.id) {
    return {
      ok: false,
      error: `message not found on team ${team.id}: ${messageId}`,
      hint: "read the room to list its message ids",
    };
  }
  if (message.discarded_at !== null) {
    return { ok: true, id: message.id, discarded_at: message.discarded_at, already: true };
  }
  const discardedAt = utcnowIso();
  await store.discardRoomMessage(message.id, discardedAt);
  return { ok: true, id: message.id, discarded_at: discardedAt, already: false };
}

// ---------------------------------------------------------------------------
// Tool spec
// ---------------------------------------------------------------------------

const roomSpec: ToolSpec = {
  name: "room",
  description:
    "Team room (#70): post/read/subscribe a team's messages. post takes team, agent_id " +
    "(the seat is resolved from its live seat session; author_* args are rejected) and body; " +
    "read/subscribe take team plus since_id/since_ts/limit/seat/task_id/kind filters " +
    "(subscribe long-polls up to wait_ms); discard marks a message obsolete.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["post", "read", "subscribe", "discard"],
        default: "read",
      },
      team: { type: "string", description: "team id" },
      team_id: { type: "string", description: "alias for team" },
      agent_id: { type: "string", description: "posting agent (post/discard)" },
      body: { type: "string", description: "message text (post)" },
      kind: { type: "string", description: "message kind, default chat (post)" },
      task_id: { type: "string", description: "linked task (post) or filter (read)" },
      attempt_id: { type: "string", description: "task attempt token (post)" },
      thread_root: { type: "string", description: "thread root message id (post)" },
      mentions: { type: "array", items: { type: "string" }, description: "mentioned seats" },
      artifact_refs: { type: "array", items: { type: "string" }, description: "artifact refs" },
      correlation_id: { type: "string", description: "correlation id (post)" },
      author_agent: { type: "string", description: "rejected: derived, never supplied" },
      author_seat: { type: "string", description: "rejected: derived, never supplied" },
      since_id: { type: "string", description: "return messages after this id (read)" },
      since: { type: "string", description: "return messages newer than this ts (read)" },
      since_ts: { type: "string", description: "alias for since" },
      limit: { type: "integer", description: "max messages, default 50" },
      seat: { type: "string", description: "author seat filter (read)" },
      wait_ms: { type: "integer", description: "long-poll budget, default 5000 (subscribe)" },
      include_discarded: { type: "boolean", description: "include obsolete messages (read)" },
      id: { type: "string", description: "message id (discard)" },
      message_id: { type: "string", description: "alias for id" },
    },
    required: ["action"],
  },
  run: (store, args) => runRoomTool(store, args),
};

/**
 * The action dispatch, shared by the MCP tool and the HTTP read path so both
 * surfaces answer identically.
 */
export function runRoomTool(
  store: Store,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = str(args, "action", "read");
  if (action === "post") return roomPost(store, args);
  if (action === "read") return roomRead(store, args);
  if (action === "subscribe") return roomSubscribe(store, args);
  if (action === "discard") return roomDiscard(store, args);
  return Promise.resolve({
    ok: false,
    error: `invalid action ${JSON.stringify(action)}`,
    hint: "must be one of: post, read, subscribe, discard",
  });
}

export const ROOM_DOMAIN: ToolDomain = {
  namespace: "team",
  tools: [roomSpec],
};
