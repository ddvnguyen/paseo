/**
 * Team room HTTP surface (#70 T1) — GET|POST /teams/{id}/room.
 *
 * Runs against the real server and a real scratch fleet.db (see
 * http-harness.ts): GET reads with since/limit filters, GET with wait_ms
 * long-polls, POST stamps the distinct `owner` author, and every route sits
 * behind the bearer gate.
 */
import { afterEach, describe, expect, it } from "vitest";
import { runTool } from "../../src/tools/registry.js";
import { isProtectedPath } from "../../src/surfaces/http/auth.js";
import { cleanupHarnesses, postJson, startHarness, type Harness } from "./http-harness.js";

afterEach(cleanupHarnesses);

const TOKEN = "room-token";

const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

async function seedTeam(harness: Harness): Promise<{ teamId: string; agentId: string }> {
  const created = (await runTool(harness.store, "team", {
    action: "create",
    name: "HTTP Room",
  })) as Record<string, unknown>;
  const teamId = String((created["team"] as Record<string, unknown>)["id"]);
  const agentId = "agent-http-dev";
  await runTool(harness.store, "team_join", { team: teamId, seat: "dev", agent_id: agentId });
  return { teamId, agentId };
}

async function agentPost(
  harness: Harness,
  teamId: string,
  agentId: string,
  body: string,
): Promise<Record<string, unknown>> {
  return (await runTool(harness.store, "room", {
    action: "post",
    team: teamId,
    agent_id: agentId,
    body,
  })) as Record<string, unknown>;
}

describe("GET /teams/:id/room", () => {
  it("reads back an agent post with its derived sender", async () => {
    const harness = await startHarness();
    const { teamId, agentId } = await seedTeam(harness);
    await agentPost(harness, teamId, agentId, "over http");

    const res = await harness.get(`/teams/${teamId}/room`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body["ok"]).toBe(true);
    const messages = body["messages"] as Record<string, unknown>[];
    expect(messages.map((m) => m["body"])).toEqual(["over http"]);
    expect(messages[0]!["author_seat"]).toBe("dev");
    expect(messages[0]!["author_agent"]).toBe(agentId);
  });

  it("honours since_id and limit from the query string", async () => {
    const harness = await startHarness();
    const { teamId, agentId } = await seedTeam(harness);
    await agentPost(harness, teamId, agentId, "one");
    await agentPost(harness, teamId, agentId, "two");
    await agentPost(harness, teamId, agentId, "three");

    const first = (await json(await harness.get(`/teams/${teamId}/room?limit=1`))) as Record<
      string,
      unknown
    >;
    expect((first["messages"] as unknown[]).length).toBe(1);

    const rest = (await json(
      await harness.get(`/teams/${teamId}/room?since_id=${first["next_since_id"]}&limit=1`),
    )) as Record<string, unknown>;
    expect((rest["messages"] as Record<string, unknown>[]).map((m) => m["body"])).toEqual(["two"]);
  });

  it("answers an unknown team with ok:false, not a 404", async () => {
    const harness = await startHarness();
    const res = await harness.get("/teams/team-nope/room");
    expect(res.status).toBe(200);
    expect((await json(res))["error"]).toBe("team not found: team-nope");
  });

  it("404s a path that is not the room route", async () => {
    const harness = await startHarness();
    const res = await harness.get("/teams/whatever/else");
    expect(res.status).toBe(404);
  });

  it("405s a wrong method on the room route", async () => {
    const harness = await startHarness();
    const res = await harness.request("/teams/t-x/room", { method: "PUT" });
    expect(res.status).toBe(405);
  });

  it("long-polls with wait_ms: returns promptly on a new post, empty on timeout", async () => {
    const harness = await startHarness();
    const { teamId, agentId } = await seedTeam(harness);

    const pending = harness.get(`/teams/${teamId}/room?wait_ms=4000`);
    await new Promise((r) => setTimeout(r, 150));
    await agentPost(harness, teamId, agentId, "just in time");
    const res = await pending;
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body["timeout"]).toBe(false);
    expect((body["messages"] as Record<string, unknown>[]).map((m) => m["body"])).toEqual([
      "just in time",
    ]);
    expect(Number(body["waited_ms"])).toBeLessThan(3500);

    // Anchor past everything seen so the next poll genuinely waits.
    const wallStart = Date.now();
    const empty = await json(
      await harness.get(`/teams/${teamId}/room?since_id=${body["next_since_id"]}&wait_ms=300`),
    );
    expect(Date.now() - wallStart).toBeGreaterThanOrEqual(200);
    expect(empty["timeout"]).toBe(true);
    expect(empty["messages"]).toEqual([]);
  });
});

describe("POST /teams/:id/room (owner write)", () => {
  it("stamps the distinct owner author", async () => {
    const harness = await startHarness();
    const { teamId } = await seedTeam(harness);

    const res = await harness.request(`/teams/${teamId}/room`, postJson({ body: "owner says hi" }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body["ok"]).toBe(true);
    const message = body["message"] as Record<string, unknown>;
    expect(message["author_seat"]).toBe("owner");
    expect(message["author_agent"]).toBe("owner");

    const read = await json(await harness.get(`/teams/${teamId}/room`));
    const bodies = (read["messages"] as Record<string, unknown>[]).map((m) => ({
      body: m["body"],
      seat: m["author_seat"],
    }));
    expect(bodies).toContainEqual({ body: "owner says hi", seat: "owner" });
  });

  it("rejects an invalid kind", async () => {
    const harness = await startHarness();
    const { teamId } = await seedTeam(harness);
    const body = await json(
      await harness.request(`/teams/${teamId}/room`, postJson({ body: "x", kind: "shout" })),
    );
    expect(body["ok"]).toBe(false);
    expect(String(body["error"])).toContain("invalid kind");
  });
});

describe("room routes behind bearer auth", () => {
  it("marks /teams paths protected, without matching longer words", () => {
    expect(isProtectedPath("/teams/t-1/room")).toBe(true);
    expect(isProtectedPath("/teams")).toBe(true);
    expect(isProtectedPath("/teamsy")).toBe(false);
  });

  it("401s the room routes without a token when one is configured", async () => {
    const harness = await startHarness({ token: TOKEN });
    const { teamId } = await seedTeam(harness);
    for (const init of [
      { method: "GET" },
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ]) {
      const res = await harness.request(`/teams/${teamId}/room`, init);
      expect(res.status).toBe(401);
    }
    const authed = await harness.get(`/teams/${teamId}/room`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(authed.status).toBe(200);
  });
});
