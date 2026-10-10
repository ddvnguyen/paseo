/**
 * Team room (LLM-Agents-Orchestration#70 T1) — room_messages and the room tool.
 *
 * The evidence this file exists to produce, in order:
 *   1. the v4 DDL round-trips on a scratch fleet.db (table, triggers, version
 *      stamp) and the store survives close/reopen (restart durability);
 *   2. post then read round-trips, ascending, pageable via since_id and
 *      since_ts, with the seat/task/kind filters;
 *   3. SENDER IDENTITY IS DERIVED: the author comes from the live seat
 *      session, a forged author_agent/author_seat is rejected, an ended
 *      session cannot post, and a vacant/unknown caller is rejected;
 *   4. subscribe long-polls: returns promptly when a new post lands, and an
 *      empty page on timeout;
 *   5. discarded_at marks a message obsolete: default reads exclude it, an
 *      include_discarded read returns it, and the row is never deleted;
 *   6. an invalid kind is rejected, and a post appends a room_posted event.
 *
 * Every store is a fresh temp fleet.db via TursoRepository — the only module
 * importing @tursodatabase/database (turso-import gate). The live
 * orchestration.sqlite is never opened.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EVENT_TYPES } from "../../src/domain/models.js";
import { TursoRepository } from "../../src/store/turso-repository.js";
import { MAX_SUBSCRIBE_WAIT_MS, ROOM_DOMAIN, ROOM_KINDS } from "../../src/tools/room.js";
import { resolveTool, runTool } from "../../src/tools/registry.js";
import { sessionTierTools, tierTools } from "../../src/domain/config.js";

const openRepos: TursoRepository[] = [];
const tmpDirs: string[] = [];

interface World {
  repo: TursoRepository;
  dbPath: string;
  teamId: string;
  trackId: string;
  projectId: string;
}

async function makeWorld(withTrack = true): Promise<World> {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-room-"));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, "fleet.db");
  const repo = await TursoRepository.open(dir, dbPath);
  openRepos.push(repo);
  let trackId = "";
  let projectId = "";
  if (withTrack) {
    const project = await repo.createProject("room-domain", [], "omp");
    const track = await repo.createTrack(project.id, "room epic", "room goal");
    trackId = track.id;
    projectId = project.id;
  }
  const created = (await runTool(repo, "team", {
    action: "create",
    name: "Room",
    ...(withTrack ? { track_id: trackId } : {}),
  })) as Record<string, unknown>;
  const teamId = String((created["team"] as Record<string, unknown>)["id"]);
  return { repo, dbPath, teamId, trackId, projectId };
}

async function join(
  repo: TursoRepository,
  teamId: string,
  seat: string,
  agentId: string,
): Promise<Record<string, unknown>> {
  return (await runTool(repo, "team_join", { team: teamId, seat, agent_id: agentId })) as Record<
    string,
    unknown
  >;
}

async function post(
  repo: TursoRepository,
  teamId: string,
  agentId: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (await runTool(repo, "room", {
    action: "post",
    team: teamId,
    agent_id: agentId,
    body,
    ...extra,
  })) as Record<string, unknown>;
}

afterEach(async () => {
  for (const repo of openRepos) await repo.close().catch(() => undefined);
  openRepos.length = 0;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------

describe("room schema v4", () => {
  it("creates room_messages, its triggers, and stamps schema_version:4", async () => {
    const world = await makeWorld();
    const tables = await TursoRepository.queryRows(
      world.dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='room_messages'",
    );
    expect(tables).toHaveLength(1);

    const triggers = await TursoRepository.queryRows(
      world.dbPath,
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='room_messages' ORDER BY name",
    );
    expect(triggers.map((r) => r["name"])).toEqual([
      "room_messages_no_delete",
      "room_messages_no_update_of_content",
    ]);

    const versions = await TursoRepository.queryRows(
      world.dbPath,
      "SELECT key FROM meta WHERE key LIKE 'schema_version:%' ORDER BY key",
    );
    expect(versions.map((r) => r["key"])).toEqual([
      "schema_version:2",
      "schema_version:3",
      "schema_version:4",
      "schema_version:5",
    ]);
  });

  it("enforces INSERT-ONLY in the database, not just in the tool", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const posted = await post(world.repo, world.teamId, "agent-dev", "hello");
    const id = String((posted["message"] as Record<string, unknown>)["id"]);

    // The one allowed update goes through; everything else aborts at the trigger.
    expect(await world.repo.discardRoomMessage(id, "2026-10-08T00:00:00.000Z")).toBe(true);
    await expect(
      TursoRepository.execScript(
        world.dbPath,
        `UPDATE room_messages SET body='hacked' WHERE id='${id}'`,
      ),
    ).rejects.toThrow(/INSERT-ONLY/);
    await expect(
      TursoRepository.execScript(world.dbPath, `DELETE FROM room_messages WHERE id='${id}'`),
    ).rejects.toThrow(/INSERT-ONLY/);
    // The row survived both attempts, still carrying its discard mark.
    const row = await world.repo.getRoomMessage(id);
    expect(row?.body).toBe("hello");
    expect(row?.discarded_at).toBe("2026-10-08T00:00:00.000Z");
  });

  it("registers room_posted in the closed event vocabulary", () => {
    expect(EVENT_TYPES.has("room_posted")).toBe(true);
    expect([...ROOM_KINDS]).toEqual([
      "chat",
      "task_assigned",
      "task_progress",
      "task_report",
      "task_verified",
      "task_rejected",
      "approval_request",
      "system",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("post then read", () => {
  it("round-trips ascending and pages via since_id", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "lead", "agent-lead");

    const first = await post(world.repo, world.teamId, "agent-dev", "one");
    expect(first["ok"]).toBe(true);
    const message = first["message"] as Record<string, unknown>;
    expect(String(message["id"])).toMatch(/^msg-/);
    expect(message["author_seat"]).toBe("dev");
    expect(message["author_agent"]).toBe("agent-dev");
    expect(message["kind"]).toBe("chat");
    expect(message["discarded_at"]).toBeNull();
    expect(first["event"]).toBe("appended");

    await post(world.repo, world.teamId, "agent-lead", "two", { kind: "system" });
    await post(world.repo, world.teamId, "agent-dev", "three", {
      kind: "task_progress",
      task_id: "task-1",
      mentions: ["lead"],
      correlation_id: "corr-1",
    });

    const page1 = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
      limit: 2,
    })) as Record<string, unknown>;
    const bodies1 = (page1["messages"] as Record<string, unknown>[]).map((m) => m["body"]);
    expect(bodies1).toEqual(["one", "two"]);

    const page2 = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
      since_id: page1["next_since_id"],
    })) as Record<string, unknown>;
    expect((page2["messages"] as Record<string, unknown>[]).map((m) => m["body"])).toEqual([
      "three",
    ]);
    const third = (page2["messages"] as Record<string, unknown>[])[0]!;
    expect(third["mentions"]).toEqual(["lead"]);
    expect(third["correlation_id"]).toBe("corr-1");
    expect(third["task_id"]).toBe("task-1");
  });

  it("pages via since_ts and filters by seat, task and kind", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "qa", "agent-qa");

    const a = await post(world.repo, world.teamId, "agent-dev", "dev note", {
      kind: "task_progress",
      task_id: "task-9",
    });
    const tsA = String((a["message"] as Record<string, unknown>)["ts"]);
    await sleep(5);
    await post(world.repo, world.teamId, "agent-qa", "qa note", { kind: "chat" });

    const since = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
      since_ts: tsA,
    })) as Record<string, unknown>;
    expect((since["messages"] as Record<string, unknown>[]).map((m) => m["body"])).toEqual([
      "qa note",
    ]);

    const bySeat = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
      seat: "dev",
    })) as Record<string, unknown>;
    expect((bySeat["messages"] as Record<string, unknown>[]).map((m) => m["body"])).toEqual([
      "dev note",
    ]);

    const byTask = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
      task_id: "task-9",
    })) as Record<string, unknown>;
    expect(byTask["count"]).toBe(1);

    const byKind = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
      kind: "chat",
    })) as Record<string, unknown>;
    expect((byKind["messages"] as Record<string, unknown>[]).map((m) => m["body"])).toEqual([
      "qa note",
    ]);
  });

  it("rejects an unknown since_id instead of returning the whole room", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await post(world.repo, world.teamId, "agent-dev", "only");
    const res = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
      since_id: "msg-nope",
    })) as Record<string, unknown>;
    expect(res["ok"]).toBe(false);
    expect(String(res["error"])).toContain("msg-nope");
  });

  it("survives close and reopen of the file db", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await post(world.repo, world.teamId, "agent-dev", "durable");
    const dir = path.dirname(world.dbPath);
    await world.repo.close();

    const reopened = await TursoRepository.open(dir, world.dbPath);
    openRepos.push(reopened);
    const read = (await runTool(reopened, "room", {
      action: "read",
      team: world.teamId,
    })) as Record<string, unknown>;
    expect((read["messages"] as Record<string, unknown>[]).map((m) => m["body"])).toEqual([
      "durable",
    ]);
  });

  it("posts on a trackless team with the event skipped, not failed", async () => {
    const world = await makeWorld(false);
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const posted = await post(world.repo, world.teamId, "agent-dev", "no tracks here");
    expect(posted["ok"]).toBe(true);
    expect(posted["event"]).toBe("skipped_no_track");
  });

  it("appends a room_posted event readable from history", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await post(world.repo, world.teamId, "agent-dev", "event me", { kind: "task_report" });
    const events = await world.repo.readEvents(world.projectId);
    const roomEvents = events.filter((e) => e["type"] === "room_posted");
    expect(roomEvents).toHaveLength(1);
    expect((roomEvents[0]!["payload"] as Record<string, unknown>)["team_id"]).toBe(world.teamId);
    expect(roomEvents[0]!["track_id"]).toBe(world.trackId);
  });
});

// ---------------------------------------------------------------------------

describe("sender identity is derived, never trusted", () => {
  it("rejects a forged author_agent and a forged author_seat", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");

    for (const forged of [{ author_agent: "agent-lead" }, { author_seat: "lead" }]) {
      const res = await post(world.repo, world.teamId, "agent-dev", "forged", forged);
      expect(res["ok"], JSON.stringify(forged)).toBe(false);
      expect(String(res["error"]), JSON.stringify(forged)).toContain("never caller-supplied");
    }
    const read = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
    })) as Record<string, unknown>;
    expect(read["count"]).toBe(0);
  });

  it("an ended seat session cannot post", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await world.repo.endSeatSession(world.teamId, "agent-dev", "2026-10-08T00:00:00.000Z", "done");

    const res = await post(world.repo, world.teamId, "agent-dev", "after the end");
    expect(res["ok"]).toBe(false);
    expect(String(res["error"])).toContain("no live seat session");
    expect(String(res["hint"])).toContain("team_join");
  });

  it("a vacant or unknown caller is rejected with an actionable error", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");

    const vacant = await post(world.repo, world.teamId, "agent-never-joined", "who am i");
    expect(vacant["ok"]).toBe(false);
    expect(String(vacant["error"])).toContain("no live seat session");
    expect(String(vacant["hint"])).toContain("team_join");

    const missing = (await runTool(world.repo, "room", {
      action: "post",
      team: world.teamId,
      body: "no caller",
    })) as Record<string, unknown>;
    expect(missing["ok"]).toBe(false);
    expect(missing["error"]).toBe("agent_id is required");
  });

  it("reserves the owner author for the HTTP path", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const res = await post(world.repo, world.teamId, "owner", "i am the owner");
    expect(res["ok"]).toBe(false);
    expect(String(res["error"])).toContain("reserved");
  });

  it("rejects an invalid kind", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const res = await post(world.repo, world.teamId, "agent-dev", "bad kind", { kind: "shout" });
    expect(res["ok"]).toBe(false);
    expect(String(res["error"])).toContain("invalid kind");
    expect(String(res["hint"])).toContain("task_report");
  });

  it("rejects an invalid action instead of guessing", async () => {
    const world = await makeWorld();
    const res = (await runTool(world.repo, "room", {
      action: "destroy",
      team: world.teamId,
    })) as Record<string, unknown>;
    expect(res["ok"]).toBe(false);
    expect(String(res["hint"])).toContain("post, read, subscribe, discard");
  });
});

// ---------------------------------------------------------------------------

describe("subscribe long-poll", () => {
  it("returns promptly when a new post lands", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const first = await post(world.repo, world.teamId, "agent-dev", "before");
    const sinceId = String((first["message"] as Record<string, unknown>)["id"]);

    const pending = runTool(world.repo, "room", {
      action: "subscribe",
      team: world.teamId,
      since_id: sinceId,
      wait_ms: 5000,
    }) as Promise<Record<string, unknown>>;
    await sleep(150);
    await post(world.repo, world.teamId, "agent-dev", "after");

    const res = await pending;
    expect(res["ok"]).toBe(true);
    expect(res["timeout"]).toBe(false);
    expect((res["messages"] as Record<string, unknown>[]).map((m) => m["body"])).toEqual(["after"]);
    // Promptly: nowhere near the 5s budget.
    expect(Number(res["waited_ms"])).toBeLessThan(4000);
  });

  it("returns empty on timeout", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const wallStart = Date.now();
    const res = (await runTool(world.repo, "room", {
      action: "subscribe",
      team: world.teamId,
      wait_ms: 400,
    })) as Record<string, unknown>;
    const wallMs = Date.now() - wallStart;
    expect(res["ok"]).toBe(true);
    expect(res["timeout"]).toBe(true);
    expect(res["messages"]).toEqual([]);
    // It actually waited (with scheduling slack), and never near the cap.
    expect(wallMs).toBeGreaterThanOrEqual(250);
    expect(wallMs).toBeLessThan(MAX_SUBSCRIBE_WAIT_MS);
  });

  it("caps wait_ms", async () => {
    const world = await makeWorld();
    expect(MAX_SUBSCRIBE_WAIT_MS).toBe(10_000);
    const wallStart = Date.now();
    const res = (await runTool(world.repo, "room", {
      action: "subscribe",
      team: world.teamId,
      wait_ms: 60_000,
    })) as Record<string, unknown>;
    const wallMs = Date.now() - wallStart;
    expect(res["timeout"]).toBe(true);
    expect(wallMs).toBeLessThan(MAX_SUBSCRIBE_WAIT_MS + 2000);
  }, 15_000);
});

// ---------------------------------------------------------------------------

describe("discarded_at", () => {
  it("marks a message obsolete: excluded by default, returned on request", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const posted = await post(world.repo, world.teamId, "agent-dev", "obsolete me");
    const id = String((posted["message"] as Record<string, unknown>)["id"]);

    const discarded = (await runTool(world.repo, "room", {
      action: "discard",
      team: world.teamId,
      id,
      agent_id: "agent-dev",
    })) as Record<string, unknown>;
    expect(discarded["ok"]).toBe(true);
    expect(discarded["already"]).toBe(false);
    expect(String(discarded["discarded_at"])).not.toBe("");

    const hidden = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
    })) as Record<string, unknown>;
    expect(hidden["messages"]).toEqual([]);

    const shown = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
      include_discarded: true,
    })) as Record<string, unknown>;
    const messages = shown["messages"] as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!["id"]).toBe(id);
    expect(String(messages[0]!["discarded_at"])).not.toBe("");

    // Discarding twice reports the first mark instead of moving it.
    const again = (await runTool(world.repo, "room", {
      action: "discard",
      team: world.teamId,
      id,
      agent_id: "agent-dev",
    })) as Record<string, unknown>;
    expect(again["ok"]).toBe(true);
    expect(again["already"]).toBe(true);
    expect(again["discarded_at"]).toBe(discarded["discarded_at"]);
  });

  it("discard needs a live session too", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const posted = await post(world.repo, world.teamId, "agent-dev", "keep me");
    const id = String((posted["message"] as Record<string, unknown>)["id"]);

    const res = (await runTool(world.repo, "room", {
      action: "discard",
      team: world.teamId,
      id,
      agent_id: "agent-stranger",
    })) as Record<string, unknown>;
    expect(res["ok"]).toBe(false);
    expect(String(res["error"])).toContain("no live seat session");
  });
});

// ---------------------------------------------------------------------------

describe("registration through the T0 seam", () => {
  it("room resolves and runs through the production resolution path", async () => {
    const spec = resolveTool("room");
    expect(spec).toBeDefined();
    expect(spec?.description).toBe(ROOM_DOMAIN.tools[0]!.description);
    expect(spec?.inputSchema).toMatchObject({ type: "object" });

    const world = await makeWorld();
    const created = await join(world.repo, world.teamId, "lead", "agent-via-seam");
    expect(created["ok"]).toBe(true);
    const posted = await post(world.repo, world.teamId, "agent-via-seam", "via seam");
    expect(posted["ok"]).toBe(true);
  });

  it("room is listed for the leader and consult tiers, like team/team_resolve", () => {
    for (const tier of ["leader", "consult"]) {
      expect(tierTools(tier)?.has("room"), tier).toBe(true);
    }
    // team_join stays call-by-name: listed nowhere.
    for (const tier of ["leader", "consult", "dev", "orchestrator"]) {
      expect(tierTools(tier)?.has("team_join"), tier).toBe(false);
    }
    expect(sessionTierTools()?.has("room")).toBe(true);
  });
});
