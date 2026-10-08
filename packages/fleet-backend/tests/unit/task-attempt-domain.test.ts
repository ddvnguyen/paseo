/**
 * Task attempts (LLM-Agents-Orchestration#70 T2) — task_attempts and the
 * task_attempt tool.
 *
 * The evidence this file exists to produce, in order:
 *   1. the v5 DDL round-trips on a scratch fleet.db (table, CHECK vocabulary,
 *      UNIQUE(team, task, attempt_no), version stamp) and the store survives
 *      close/reopen (restart durability);
 *   2. start mints an opaque attempt_id with monotonic attempt_no, resolves
 *      the seat from the live session, and supersedes the previous generation
 *      without deleting it;
 *   3. report takes ONLY the current token (stale or unknown attempt_id is
 *      refused), moves started->delivered, and posts a typed task_report room
 *      message;
 *   4. verify moves delivered->verified|rejected, posts the verdict message,
 *      refuses `verified` without evidence, refuses a verifier deciding their
 *      own attempt, and refuses to decide anything but a delivered attempt;
 *   5. `delivered` is NOT `verified`: dependenciesSatisfied is true only when
 *      every dependency's current attempt is verified (empty deps pass
 *      vacuously; wiring into the ledger scheduler is out of scope);
 *   6. SENDER IDENTITY IS DERIVED: forged author args are rejected, ended
 *      seat sessions cannot act, the owner id stays reserved.
 *
 * Every store is a fresh temp fleet.db via TursoRepository — the only module
 * importing @tursodatabase/database (turso-import gate). The live
 * orchestration.sqlite is never opened.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionTierTools, tierTools } from "../../src/domain/config.js";
import { TursoRepository } from "../../src/store/turso-repository.js";
import {
  ATTEMPT_STATUSES,
  ATTEMPT_VERDICTS,
  TASK_ATTEMPT_DOMAIN,
  currentAttemptIsVerified,
  dependenciesSatisfied,
} from "../../src/tools/task-attempt.js";
import { resolveTool, runTool } from "../../src/tools/registry.js";

const openRepos: TursoRepository[] = [];
const tmpDirs: string[] = [];

interface World {
  repo: TursoRepository;
  dbPath: string;
  teamId: string;
  trackId: string;
  projectId: string;
}

async function makeWorld(): Promise<World> {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-attempt-"));
  tmpDirs.push(dir);
  const dbPath = path.join(dir, "fleet.db");
  const repo = await TursoRepository.open(dir, dbPath);
  openRepos.push(repo);
  const project = await repo.createProject("attempt-domain", [], "omp");
  const track = await repo.createTrack(project.id, "attempt epic", "attempt goal");
  const created = (await runTool(repo, "team", {
    action: "create",
    name: "Attempts",
    track_id: track.id,
  })) as Record<string, unknown>;
  const teamId = String((created["team"] as Record<string, unknown>)["id"]);
  return { repo, dbPath, teamId, trackId: track.id, projectId: project.id };
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

async function start(
  repo: TursoRepository,
  teamId: string,
  agentId: string,
  taskId: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (await runTool(repo, "task_attempt", {
    action: "start",
    team: teamId,
    agent_id: agentId,
    task_id: taskId,
    ...extra,
  })) as Record<string, unknown>;
}

async function report(
  repo: TursoRepository,
  teamId: string,
  agentId: string,
  attemptId: string,
  summary = "delivered the thing",
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (await runTool(repo, "task_attempt", {
    action: "report",
    team: teamId,
    agent_id: agentId,
    attempt_id: attemptId,
    summary,
    ...extra,
  })) as Record<string, unknown>;
}

const EVIDENCE: Record<string, unknown> = {
  acceptanceResults: [{ criterion: "vitest green", status: "passed", evidence: "12/12" }],
  commandsRun: [{ command: "npx vitest run", status: "passed", exitCode: 0 }],
  changedPaths: ["src/thing.ts"],
};

async function verify(
  repo: TursoRepository,
  teamId: string,
  agentId: string,
  attemptId: string,
  verdict: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return (await runTool(repo, "task_attempt", {
    action: "verify",
    team: teamId,
    agent_id: agentId,
    attempt_id: attemptId,
    verdict,
    ...extra,
  })) as Record<string, unknown>;
}

/** Drive one task to verified and return its attempt_id. */
async function driveToVerified(
  repo: TursoRepository,
  teamId: string,
  worker: string,
  verifier: string,
  taskId: string,
): Promise<string> {
  const started = await start(repo, teamId, worker, taskId);
  expect(started["ok"]).toBe(true);
  const attemptId = String(started["attempt_id"]);
  const reported = await report(repo, teamId, worker, attemptId);
  expect(reported["ok"]).toBe(true);
  const decided = await verify(repo, teamId, verifier, attemptId, "verified", {
    evidence: EVIDENCE,
  });
  expect(decided["ok"]).toBe(true);
  return attemptId;
}

afterEach(async () => {
  for (const repo of openRepos) await repo.close().catch(() => undefined);
  openRepos.length = 0;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

// ---------------------------------------------------------------------------

describe("attempt schema v5", () => {
  it("creates task_attempts and stamps schema_version:5", async () => {
    const world = await makeWorld();
    const tables = await TursoRepository.queryRows(
      world.dbPath,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_attempts'",
    );
    expect(tables).toHaveLength(1);

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

  it("pins the status vocabulary and the per-task attempt_no uniqueness in the database", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-1");
    const attemptId = String(started["attempt_id"]);

    await expect(
      TursoRepository.execScript(
        world.dbPath,
        `UPDATE task_attempts SET status='flying' WHERE attempt_id='${attemptId}'`,
      ),
    ).rejects.toThrow(/CHECK/);
    await expect(
      TursoRepository.execScript(
        world.dbPath,
        `INSERT INTO task_attempts(attempt_id, team_id, task_id, attempt_no, seat, agent_id,
          status, evidence, verifier_seat, verifier_agent, created_at, updated_at, decided_at)
         VALUES('att-dupe', '${world.teamId}', 'task-1', 1, 'dev', 'agent-dev',
          'started', '{}', '', '', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z', NULL)`,
      ),
    ).rejects.toThrow(/UNIQUE/);
    // The row survived both attempts.
    expect((await world.repo.getTaskAttempt(attemptId))?.status).toBe("started");
  });

  it("registers the attempt vocabulary", () => {
    expect([...ATTEMPT_STATUSES]).toEqual([
      "started",
      "delivered",
      "verified",
      "rejected",
      "superseded",
    ]);
    expect([...ATTEMPT_VERDICTS]).toEqual(["verified", "rejected"]);
  });
});

// ---------------------------------------------------------------------------

describe("start", () => {
  it("mints an opaque attempt_id with monotonic attempt_no and the derived seat", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const res = await start(world.repo, world.teamId, "agent-dev", "task-1");
    expect(res["ok"]).toBe(true);
    expect(String(res["attempt_id"])).toMatch(/^att-/);
    expect(res["attempt_no"]).toBe(1);
    expect(res["seat"]).toBe("dev");
    expect(res["status"]).toBe("started");
    expect(res["superseded"]).toBe(0);

    const row = await world.repo.getTaskAttempt(String(res["attempt_id"]));
    expect(row?.task_id).toBe("task-1");
    expect(row?.attempt_no).toBe(1);
  });

  it("a new start supersedes the previous generation and invalidates its token without deleting", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const first = await start(world.repo, world.teamId, "agent-dev", "task-1");
    const firstId = String(first["attempt_id"]);

    const second = await start(world.repo, world.teamId, "agent-dev", "task-1");
    expect(second["ok"]).toBe(true);
    expect(second["attempt_no"]).toBe(2);
    expect(second["superseded"]).toBe(1);

    // Nothing is ever deleted: both rows are still there.
    const rows = await world.repo.listTaskAttempts(world.teamId, "task-1");
    expect(rows.map((r) => [r.attempt_no, r.status])).toEqual([
      [1, "superseded"],
      [2, "started"],
    ]);

    // The old token is stale: reporting against it is refused.
    const stale = await report(world.repo, world.teamId, "agent-dev", firstId);
    expect(stale["ok"]).toBe(false);
    expect(String(stale["error"])).toContain("stale attempt_id");
    expect(stale["current_attempt_id"]).toBe(String(second["attempt_id"]));
  });

  it("verified history is never rewritten by a later start", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "lead", "agent-lead");
    const verifiedId = await driveToVerified(
      world.repo,
      world.teamId,
      "agent-dev",
      "agent-lead",
      "task-1",
    );

    const rework = await start(world.repo, world.teamId, "agent-dev", "task-1");
    expect(rework["ok"]).toBe(true);
    expect(rework["attempt_no"]).toBe(2);
    // The terminal verdict stays; only live rows move.
    expect((await world.repo.getTaskAttempt(verifiedId))?.status).toBe("verified");
  });

  it("attempt_no sequences are per task", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await start(world.repo, world.teamId, "agent-dev", "task-a");
    const other = await start(world.repo, world.teamId, "agent-dev", "task-b");
    expect(other["attempt_no"]).toBe(1);
  });

  it("needs a live session, a team and a task", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");

    const stranger = await start(world.repo, world.teamId, "agent-never-joined", "task-1");
    expect(stranger["ok"]).toBe(false);
    expect(String(stranger["error"])).toContain("no live seat session");

    const noTask = (await runTool(world.repo, "task_attempt", {
      action: "start",
      team: world.teamId,
      agent_id: "agent-dev",
    })) as Record<string, unknown>;
    expect(noTask["ok"]).toBe(false);
    expect(noTask["error"]).toBe("task_id is required");

    const noTeam = (await runTool(world.repo, "task_attempt", {
      action: "start",
      agent_id: "agent-dev",
      task_id: "task-1",
    })) as Record<string, unknown>;
    expect(noTeam["ok"]).toBe(false);
    expect(noTeam["error"]).toBe("team is required");
  });

  it("rejects forged authors and the reserved owner id", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");

    for (const forged of [{ author_agent: "agent-lead" }, { author_seat: "lead" }]) {
      const res = await start(world.repo, world.teamId, "agent-dev", "task-1", forged);
      expect(res["ok"], JSON.stringify(forged)).toBe(false);
      expect(String(res["error"]), JSON.stringify(forged)).toContain("never caller-supplied");
    }
    const owner = await start(world.repo, world.teamId, "owner", "task-1");
    expect(owner["ok"]).toBe(false);
    expect(String(owner["error"])).toContain("reserved");
  });

  it("an ended seat session cannot start, report or verify", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "lead", "agent-lead");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-1");
    const attemptId = String(started["attempt_id"]);
    await world.repo.endSeatSession(world.teamId, "agent-dev", "2026-10-08T00:00:00.000Z", "done");

    expect((await start(world.repo, world.teamId, "agent-dev", "task-2"))["ok"]).toBe(false);
    const reported = await report(world.repo, world.teamId, "agent-dev", attemptId);
    expect(reported["ok"]).toBe(false);
    expect(String(reported["error"])).toContain("no live seat session");
    const decided = await verify(world.repo, world.teamId, "agent-dev", attemptId, "verified", {
      evidence: EVIDENCE,
    });
    expect(decided["ok"]).toBe(false);
    expect(String(decided["error"])).toContain("no live seat session");
  });

  it("rejects an invalid action instead of guessing", async () => {
    const world = await makeWorld();
    const res = (await runTool(world.repo, "task_attempt", {
      action: "destroy",
      team: world.teamId,
    })) as Record<string, unknown>;
    expect(res["ok"]).toBe(false);
    expect(String(res["hint"])).toContain("start, report, verify");
  });
});

// ---------------------------------------------------------------------------

describe("report", () => {
  it("moves started->delivered and posts a typed task_report room message", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-1");
    const attemptId = String(started["attempt_id"]);

    const res = await report(world.repo, world.teamId, "agent-dev", attemptId, "here it is");
    expect(res["ok"]).toBe(true);
    expect(res["status"]).toBe("delivered");
    expect(res["event"]).toBe("appended");

    const row = await world.repo.getTaskAttempt(attemptId);
    expect(row?.status).toBe("delivered");

    const read = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
      kind: "task_report",
    })) as Record<string, unknown>;
    const messages = read["messages"] as Record<string, unknown>[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!["body"]).toBe("here it is");
    expect(messages[0]!["attempt_id"]).toBe(attemptId);
    expect(messages[0]!["task_id"]).toBe("task-1");
    expect(messages[0]!["author_seat"]).toBe("dev");
  });

  it("refuses an unknown attempt_id", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const res = await report(world.repo, world.teamId, "agent-dev", "att-nope");
    expect(res["ok"]).toBe(false);
    expect(String(res["error"])).toContain("unknown attempt_id");
  });

  it("refuses a token from another team", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-1");

    const other = (await runTool(world.repo, "team", {
      action: "create",
      name: "Other",
    })) as Record<string, unknown>;
    const otherId = String((other["team"] as Record<string, unknown>)["id"]);
    await join(world.repo, otherId, "dev", "agent-dev");
    const res = await report(world.repo, otherId, "agent-dev", String(started["attempt_id"]));
    expect(res["ok"]).toBe(false);
    expect(String(res["error"])).toContain("not on team");
  });

  it("a delivered attempt cannot be reported twice, nor a decided one", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "lead", "agent-lead");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-1");
    const attemptId = String(started["attempt_id"]);
    expect((await report(world.repo, world.teamId, "agent-dev", attemptId))["ok"]).toBe(true);

    const again = await report(world.repo, world.teamId, "agent-dev", attemptId);
    expect(again["ok"]).toBe(false);
    expect(String(again["error"])).toContain("not started");

    expect(
      (
        await verify(world.repo, world.teamId, "agent-lead", attemptId, "verified", {
          evidence: EVIDENCE,
        })
      )["ok"],
    ).toBe(true);
    const after = await report(world.repo, world.teamId, "agent-dev", attemptId);
    expect(after["ok"]).toBe(false);
  });

  it("requires a summary for the room message", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-1");
    const res = (await runTool(world.repo, "task_attempt", {
      action: "report",
      team: world.teamId,
      agent_id: "agent-dev",
      attempt_id: String(started["attempt_id"]),
    })) as Record<string, unknown>;
    expect(res["ok"]).toBe(false);
    expect(res["error"]).toBe("summary is required");
  });
});

// ---------------------------------------------------------------------------

describe("verify", () => {
  it("verifies a delivered attempt with evidence and posts task_verified", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "lead", "agent-lead");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-1");
    const attemptId = String(started["attempt_id"]);
    await report(world.repo, world.teamId, "agent-dev", attemptId);

    const res = await verify(world.repo, world.teamId, "agent-lead", attemptId, "verified", {
      evidence: EVIDENCE,
    });
    expect(res["ok"]).toBe(true);
    expect(res["status"]).toBe("verified");
    expect(res["verifier_seat"]).toBe("lead");

    const row = await world.repo.getTaskAttempt(attemptId);
    expect(row?.status).toBe("verified");
    expect(row?.verifier_seat).toBe("lead");
    expect(row?.verifier_agent).toBe("agent-lead");
    expect(row?.decided_at).not.toBeNull();
    expect(JSON.parse(row!.evidence)).toEqual(EVIDENCE);

    const read = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
      kind: "task_verified",
    })) as Record<string, unknown>;
    expect(read["count"]).toBe(1);
  });

  it("refuses verified without evidence", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "lead", "agent-lead");

    const cases: Record<string, unknown>[] = [
      {},
      { evidence: undefined },
      { evidence: "looks good" },
      { evidence: {} },
      { evidence: { commandsRun: [], changedPaths: [] } },
      { evidence: { acceptanceResults: [], commandsRun: [], changedPaths: [] } },
      {
        evidence: {
          acceptanceResults: [{ criterion: "", status: "passed" }],
          commandsRun: [],
          changedPaths: [],
        },
      },
      {
        evidence: {
          acceptanceResults: [{ criterion: "x", status: "maybe" }],
          commandsRun: [],
          changedPaths: [],
        },
      },
      {
        evidence: {
          acceptanceResults: [{ criterion: "x", status: "passed" }],
          changedPaths: [],
        },
      },
    ];
    for (const [i, extra] of cases.entries()) {
      const taskId = `task-ev-${i}`;
      const started = await start(world.repo, world.teamId, "agent-dev", taskId);
      const attemptId = String(started["attempt_id"]);
      await report(world.repo, world.teamId, "agent-dev", attemptId);
      const res = await verify(
        world.repo,
        world.teamId,
        "agent-lead",
        attemptId,
        "verified",
        extra,
      );
      expect(res["ok"], `case ${i}: ${JSON.stringify(extra)}`).toBe(false);
      expect(String(res["error"]), `case ${i}`).toContain("without evidence");
      expect((await world.repo.getTaskAttempt(attemptId))?.status, `case ${i}`).toBe("delivered");
    }
  });

  it("rejects with a reason and posts task_rejected", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "lead", "agent-lead");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-1");
    const attemptId = String(started["attempt_id"]);
    await report(world.repo, world.teamId, "agent-dev", attemptId);

    const noReason = await verify(world.repo, world.teamId, "agent-lead", attemptId, "rejected");
    expect(noReason["ok"]).toBe(false);
    expect(String(noReason["error"])).toContain("reason is required");

    const res = await verify(world.repo, world.teamId, "agent-lead", attemptId, "rejected", {
      reason: "tests fail on main",
    });
    expect(res["ok"]).toBe(true);
    expect(res["status"]).toBe("rejected");
    expect((await world.repo.getTaskAttempt(attemptId))?.status).toBe("rejected");

    const read = (await runTool(world.repo, "room", {
      action: "read",
      team: world.teamId,
      kind: "task_rejected",
    })) as Record<string, unknown>;
    expect(read["count"]).toBe(1);
  });

  it("cannot verify what was never delivered", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "lead", "agent-lead");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-1");
    const attemptId = String(started["attempt_id"]);

    const early = await verify(world.repo, world.teamId, "agent-lead", attemptId, "verified", {
      evidence: EVIDENCE,
    });
    expect(early["ok"]).toBe(false);
    expect(String(early["error"])).toContain("not delivered");

    const badVerdict = (await runTool(world.repo, "task_attempt", {
      action: "verify",
      team: world.teamId,
      agent_id: "agent-lead",
      attempt_id: attemptId,
      verdict: "maybe",
    })) as Record<string, unknown>;
    expect(badVerdict["ok"]).toBe(false);
    expect(String(badVerdict["hint"])).toContain("verified, rejected");
  });

  it("a verifier cannot verify their own attempt", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-1");
    const attemptId = String(started["attempt_id"]);
    await report(world.repo, world.teamId, "agent-dev", attemptId);

    const self = await verify(world.repo, world.teamId, "agent-dev", attemptId, "verified", {
      evidence: EVIDENCE,
    });
    expect(self["ok"]).toBe(false);
    expect(String(self["error"])).toContain("cannot verify its own attempt");
    expect((await world.repo.getTaskAttempt(attemptId))?.status).toBe("delivered");
  });

  it("the same agent cannot self-verify from a second seat either", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "qa", "agent-dev");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-1");
    expect(started["seat"]).toBe("dev");
    const attemptId = String(started["attempt_id"]);
    await report(world.repo, world.teamId, "agent-dev", attemptId);

    // agent-dev holds both dev and qa here; the agent check still refuses.
    const res = await verify(world.repo, world.teamId, "agent-dev", attemptId, "verified", {
      evidence: EVIDENCE,
    });
    expect(res["ok"]).toBe(false);
    expect(String(res["error"])).toContain("cannot verify its own attempt");
  });

  it("verifying needs a live session and honest args too", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "lead", "agent-lead");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-1");
    const attemptId = String(started["attempt_id"]);
    await report(world.repo, world.teamId, "agent-dev", attemptId);

    const stranger = await verify(
      world.repo,
      world.teamId,
      "agent-stranger",
      attemptId,
      "verified",
      { evidence: EVIDENCE },
    );
    expect(stranger["ok"]).toBe(false);
    expect(String(stranger["error"])).toContain("no live seat session");

    const forged = await verify(world.repo, world.teamId, "agent-lead", attemptId, "verified", {
      evidence: EVIDENCE,
      author_seat: "lead",
    });
    expect(forged["ok"]).toBe(false);
    expect(String(forged["error"])).toContain("never caller-supplied");
  });
});

// ---------------------------------------------------------------------------

describe("dependenciesSatisfied", () => {
  it("delivered is NOT verified: the gate opens only on a verifier verdict", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "lead", "agent-lead");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-dep");
    const attemptId = String(started["attempt_id"]);
    await report(world.repo, world.teamId, "agent-dev", attemptId);

    expect(await currentAttemptIsVerified(world.repo, world.teamId, "task-dep")).toBe(false);
    const gated = await dependenciesSatisfied(world.repo, world.teamId, "task-next", ["task-dep"]);
    expect(gated.satisfied).toBe(false);
    expect(gated.blocked).toEqual(["task-dep"]);

    await verify(world.repo, world.teamId, "agent-lead", attemptId, "verified", {
      evidence: EVIDENCE,
    });
    expect(await currentAttemptIsVerified(world.repo, world.teamId, "task-dep")).toBe(true);
    const open = await dependenciesSatisfied(world.repo, world.teamId, "task-next", ["task-dep"]);
    expect(open).toEqual({ task_id: "task-next", satisfied: true, blocked: [] });
  });

  it("empty dependencies pass vacuously; unknown tasks block", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    expect((await dependenciesSatisfied(world.repo, world.teamId, "task-x", [])).satisfied).toBe(
      true,
    );
    const missing = await dependenciesSatisfied(world.repo, world.teamId, "task-x", ["task-ghost"]);
    expect(missing.satisfied).toBe(false);
    expect(missing.blocked).toEqual(["task-ghost"]);
  });

  it("a rejected dependency blocks, and rework after verified closes the gate again", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "lead", "agent-lead");
    const started = await start(world.repo, world.teamId, "agent-dev", "task-dep");
    const attemptId = String(started["attempt_id"]);
    await report(world.repo, world.teamId, "agent-dev", attemptId);
    await verify(world.repo, world.teamId, "agent-lead", attemptId, "rejected", {
      reason: "not yet",
    });
    expect(
      (await dependenciesSatisfied(world.repo, world.teamId, "task-next", ["task-dep"])).satisfied,
    ).toBe(false);

    // Rework supersedes the rejection: the gate stays closed until re-verified.
    const rework = await start(world.repo, world.teamId, "agent-dev", "task-dep");
    expect(rework["attempt_no"]).toBe(2);
    expect(
      (await dependenciesSatisfied(world.repo, world.teamId, "task-next", ["task-dep"])).satisfied,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("restart durability", () => {
  it("survives close and reopen of the file db", async () => {
    const world = await makeWorld();
    await join(world.repo, world.teamId, "dev", "agent-dev");
    await join(world.repo, world.teamId, "lead", "agent-lead");
    const verifiedId = await driveToVerified(
      world.repo,
      world.teamId,
      "agent-dev",
      "agent-lead",
      "task-1",
    );
    const dir = path.dirname(world.dbPath);
    await world.repo.close();

    const reopened = await TursoRepository.open(dir, world.dbPath);
    openRepos.push(reopened);
    const current = await reopened.getCurrentTaskAttempt(world.teamId, "task-1");
    expect(current?.attempt_id).toBe(verifiedId);
    expect(current?.status).toBe("verified");
    expect(JSON.parse(current!.evidence)).toEqual(EVIDENCE);
    expect(await currentAttemptIsVerified(reopened, world.teamId, "task-1")).toBe(true);
    const read = (await runTool(reopened, "room", {
      action: "read",
      team: world.teamId,
      kind: "task_verified",
    })) as Record<string, unknown>;
    expect(read["count"]).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("registration through the T0 seam", () => {
  it("task_attempt resolves and runs through the production resolution path", async () => {
    const spec = resolveTool("task_attempt");
    expect(spec).toBeDefined();
    expect(spec?.description).toBe(TASK_ATTEMPT_DOMAIN.tools[0]!.description);
    expect(spec?.inputSchema).toMatchObject({ type: "object" });

    const world = await makeWorld();
    await join(world.repo, world.teamId, "lead", "agent-via-seam");
    const started = await start(world.repo, world.teamId, "agent-via-seam", "task-seam");
    expect(started["ok"]).toBe(true);
  });

  it("task_attempt is listed for the leader and consult tiers, like room", () => {
    for (const tier of ["leader", "consult"]) {
      expect(tierTools(tier)?.has("task_attempt"), tier).toBe(true);
    }
    expect(tierTools("dev")?.has("task_attempt")).toBe(false);
    expect(sessionTierTools()?.has("task_attempt")).toBe(true);
  });
});
