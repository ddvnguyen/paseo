/**
 * Team room HTTP surface (#70 T1) — GET|POST /teams/{id}/room.
 *
 * GET is the UI read path: same filters as room(action=read) via the query
 * string (since_id/since_ts/limit/seat/task_id/kind/include_discarded), plus
 * wait_ms for the long-poll subscribe (returns as soon as a newer message
 * exists, or an empty page on timeout). Reads run through the `room` tool
 * itself, so HTTP and MCP can never disagree on shape.
 *
 * POST is the OWNER write path, and it is deliberately separate from the
 * agent path: the caller is the owner UI, authenticated by the bearer token
 * (the route is behind the auth gate in auth.ts), not by a seat session.
 * The message is stamped with the distinct `owner` author (OWNER_AUTHOR),
 * which no agent can hold or forge — the agent tool rejects agent_id "owner"
 * and rejects every author_* override before seat resolution, and "owner" is
 * not a seat so no live seat session can ever resolve to it.
 *
 * Bodies follow the POST /tools/{name} convention: an unparseable body reads
 * as {}, which then fails the field checks below rather than 400ing at the
 * transport.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../../store/store-interface.js";
import { newId, utcnowIso } from "../../domain/models.js";
import { OWNER_AUTHOR, ROOM_KINDS, appendRoomEvent, runRoomTool } from "../../tools/room.js";
import { sendJson, sendUnexpected } from "./responses.js";

const TEAMS_PREFIX = "/teams/";
const ROOM_SUFFIX = "/room";

/** True when this path is ours; the id is returned for the handlers. */
export function matchTeamsRoom(path: string): string | null {
  if (!path.startsWith(TEAMS_PREFIX) || !path.endsWith(ROOM_SUFFIX)) return null;
  const teamId = decodeURIComponent(path.slice(TEAMS_PREFIX.length, -ROOM_SUFFIX.length));
  if (teamId.length === 0 || teamId.includes("/")) return null;
  return teamId;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, dflt = ""): string {
  if (value === null || value === undefined) return dflt;
  const s = String(value).trim();
  return s === "" ? dflt : s;
}

/** GET /teams/{id}/room — read, or long-poll when wait_ms > 0. */
export async function handleRoomGet(
  res: ServerResponse,
  store: Store,
  teamId: string,
  query: URLSearchParams,
): Promise<void> {
  const get = (key: string): string => (query.get(key) ?? "").trim();
  const args: Record<string, unknown> = { action: "read", team: teamId };
  for (const key of [
    "since_id",
    "since",
    "since_ts",
    "limit",
    "seat",
    "task_id",
    "kind",
    "include_discarded",
    "wait_ms",
  ]) {
    const value = get(key);
    if (value !== "") args[key] = value;
  }
  const waitMs = get("wait_ms");
  if (waitMs !== "" && waitMs !== "0") args["action"] = "subscribe";
  try {
    const result = await runRoomTool(store, args);
    sendJson(res, 200, result ?? null);
  } catch (exc) {
    sendUnexpected(res, exc);
  }
}

/** POST /teams/{id}/room — owner write, stamped with the `owner` author. */
export async function handleRoomPost(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  teamId: string,
): Promise<void> {
  const rawBody = await readBody(req);
  const body = isPlainObject(rawBody) ? rawBody : {};
  const text = str(body["body"]);
  if (!text) {
    sendJson(res, 200, { ok: false, error: "body is required", hint: "pass the message text" });
    return;
  }
  const kind = str(body["kind"], "chat");
  if (!ROOM_KINDS.includes(kind)) {
    sendJson(res, 200, {
      ok: false,
      error: `invalid kind ${JSON.stringify(kind)}`,
      hint: `must be one of: ${ROOM_KINDS.join(", ")}`,
    });
    return;
  }
  try {
    const team = await store.getTeam(teamId);
    if (!team) {
      sendJson(res, 200, {
        ok: false,
        error: `team not found: ${teamId}`,
        hint: "list teams or create one first with team(action=create)",
      });
      return;
    }
    const asArray = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.map((item) => String(item).trim()).filter((item) => item !== "")
        : [];
    const message = {
      id: newId("msg"),
      team_id: team.id,
      ts: utcnowIso(),
      author_seat: OWNER_AUTHOR,
      author_agent: OWNER_AUTHOR,
      kind,
      task_id: str(body["task_id"]),
      attempt_id: str(body["attempt_id"]),
      thread_root: str(body["thread_root"]),
      mentions: asArray(body["mentions"]),
      body: text,
      artifact_refs: asArray(body["artifact_refs"]),
      correlation_id: str(body["correlation_id"]),
      discarded_at: null,
    };
    await store.postRoomMessage(message);
    const event = await appendRoomEvent(store, message);
    sendJson(res, 200, { ok: true, message, event });
  } catch (exc) {
    sendUnexpected(res, exc);
  }
}
