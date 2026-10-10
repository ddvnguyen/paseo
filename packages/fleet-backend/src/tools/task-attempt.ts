/**
 * T2 design note (#70): attempt fencing for team tasks.
 * A task's work happens in generations; only the CURRENT generation
 * (highest attempt_no) holds a live token, so a stale report can never
 * land on rework. start mints (att-*) and supersedes live older rows;
 * verified/rejected rows are terminal history, never rewritten.
 * report moves started->delivered and posts task_report to the room;
 * verify moves delivered->verified|rejected and posts the verdict.
 * verified demands evidence (non-empty acceptanceResults + commandsRun
 * + changedPaths); delivered is never enough for dependenciesSatisfied.
 * The verifier's seat must differ from the worker's seat. Identity is
 * derived from live seat_sessions like room.ts; author_* is rejected.
 * Deps are caller-supplied (orch_tasks has no edges); scheduler wiring
 * is out of scope. Table is team-scoped: no FK onto orch_* (finding 9).
 */

/**
 * Task-attempt domain tool — LLM-Agents-Orchestration#70 T2 (Team Room v1).
 *
 * One tool, three actions: start | report | verify. Registered through the
 * T0 seam (tools/registry.ts) as its own domain; room.ts semantics are
 * untouched (this file only READS room.ts: OWNER_AUTHOR plus the shared
 * appendRoomEvent, so verdict posts stay visible in history exactly like
 * chat posts).
 *
 * SENDER IDENTITY IS DERIVED, NEVER TRUSTED (mirrors room.ts): every action
 * resolves the caller seat from the caller's agent_id through the LIVE seat
 * session (seat_sessions, ended_at IS NULL). Client-supplied
 * author_agent/author_seat args are rejected outright, and agent_id "owner"
 * stays reserved for the bearer-authenticated owner UI.
 *
 * Attempt fencing (the idea follows dsh-agent-teams src/types.ts
 * TeamTask.attempt/attemptId and mailbox.ts isCurrentMail — MIT, idea only,
 * no code copied): the attempt_id is an opaque capability. report and verify
 * accept ONLY the current generation's token; a stale (superseded) or
 * unknown token is refused, so late-arriving worker output can never land on
 * rework. `delivered` is a claim; only `verified` unlocks dependents, via
 * dependenciesSatisfied below.
 *
 * Import discipline (mirrors src/mcp.ts and tools/team.ts): importing this
 * module must have no side effects. Pure declarations only.
 */
import { newId, utcnowIso } from "../domain/models.js";
import type {
  AcceptanceResult,
  CommandResult,
  Store,
  TaskAttemptRow,
} from "../store/store-interface.js";
import { appendRoomEvent, OWNER_AUTHOR } from "./room.js";
import type { ToolDomain, ToolSpec } from "./registry.js";

/** Attempt statuses, exactly the #70 T2 vocabulary (also CHECK-pinned in DDL). */
export const ATTEMPT_STATUSES: readonly string[] = [
  "started",
  "delivered",
  "verified",
  "rejected",
  "superseded",
];

/** Verdicts the verify action accepts. */
export const ATTEMPT_VERDICTS: readonly string[] = ["verified", "rejected"];

// ---------------------------------------------------------------------------
// Argument reading — total accessors, mirroring tools/room.ts.
// ---------------------------------------------------------------------------

function str(args: Record<string, unknown>, key: string, dflt = ""): string {
  const v = args[key];
  if (v === null || v === undefined) return dflt;
  const s = String(v).trim();
  return s === "" ? dflt : s;
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
    hint: "join a seat first with team_join(team, seat, agent_id); an unknown agent, or a session that has ended, cannot act on attempts",
  };
}

/** A present-but-forbidden author override: the forgery tripwire (as in room.ts). */
function forgedAuthor(args: Record<string, unknown>): string | null {
  for (const key of ["author_agent", "author_seat"]) {
    if (str(args, key) !== "") return key;
  }
  return null;
}

function reservedOwner(agentId: string): Record<string, unknown> | null {
  if (agentId !== OWNER_AUTHOR) return null;
  return {
    ok: false,
    error: `agent_id ${OWNER_AUTHOR} is reserved for the bearer-authenticated owner UI`,
    hint: "agents act with their own agent id",
  };
}

/** The caller's live seat, or an error payload when the caller may not act. */
async function liveSeat(
  store: Store,
  teamId: string,
  agentId: string,
): Promise<{ seat: string } | { error: Record<string, unknown> }> {
  const team = await store.getTeam(teamId);
  if (!team) return { error: unknownTeam(teamId) };
  const session = await store.findLiveSeatSession(team.id, agentId);
  if (!session) return { error: noLiveSeat(agentId, team.id) };
  return { seat: session.seat };
}

/** The current (highest attempt_no) row must hold the presented token. */
async function currentAttempt(
  store: Store,
  teamId: string,
  taskId: string,
): Promise<TaskAttemptRow | null> {
  return store.getCurrentTaskAttempt(teamId, taskId);
}

function staleToken(
  presented: string,
  current: TaskAttemptRow | null,
): Record<string, unknown> | null {
  if (current && current.attempt_id === presented) return null;
  return {
    ok: false,
    error: `stale attempt_id ${presented}: it is not the current attempt for this task`,
    hint:
      current === null
        ? "no attempt exists for this task yet — start one first"
        : `the current attempt is ${current.attempt_id} (attempt_no ${current.attempt_no}, status ${current.status}) — report against that token`,
    current_attempt_id: current?.attempt_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Evidence — the shape follows dsh-agent-teams src/types.ts
// (AcceptanceResult, CommandResult — MIT, idea only, no code copied).
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkAcceptanceResults(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return "acceptanceResults must be a non-empty array";
  for (const item of v) {
    if (!isRecord(item)) return "every acceptanceResults entry must be an object";
    if (typeof item["criterion"] !== "string" || item["criterion"].trim() === "") {
      return "every acceptanceResults entry needs a non-empty criterion";
    }
    if (item["status"] !== "passed" && item["status"] !== "failed") {
      return "every acceptanceResults entry needs status passed|failed";
    }
  }
  return null;
}

function checkCommandsRun(v: unknown): string | null {
  if (!Array.isArray(v)) return "commandsRun must be an array";
  for (const item of v) {
    if (!isRecord(item)) return "every commandsRun entry must be an object";
    if (typeof item["command"] !== "string" || item["command"].trim() === "") {
      return "every commandsRun entry needs a non-empty command";
    }
    if (item["status"] !== "passed" && item["status"] !== "failed") {
      return "every commandsRun entry needs status passed|failed";
    }
  }
  return null;
}

function checkChangedPaths(v: unknown): string | null {
  if (!Array.isArray(v)) return "changedPaths must be an array";
  for (const item of v) {
    if (typeof item !== "string" || item.trim() === "") {
      return "every changedPaths entry must be a non-empty string";
    }
  }
  return null;
}

/**
 * Full verification evidence: all three keys present, acceptanceResults
 * non-empty. commandsRun and changedPaths may be empty arrays, but the keys
 * must be there — a verifier must say what ran and what changed, even when
 * the answer is "nothing".
 */
function checkVerifyEvidence(v: unknown): { error: string } | { value: Record<string, unknown> } {
  if (!isRecord(v)) return { error: "evidence must be an object" };
  for (const [key, check] of [
    ["acceptanceResults", checkAcceptanceResults],
    ["commandsRun", checkCommandsRun],
    ["changedPaths", checkChangedPaths],
  ] as const) {
    if (!(key in v)) return { error: `${key} is required in evidence` };
    const problem = check(v[key]);
    if (problem) return { error: problem };
  }
  return {
    value: {
      acceptanceResults: v["acceptanceResults"] as AcceptanceResult[],
      commandsRun: v["commandsRun"] as CommandResult[],
      changedPaths: v["changedPaths"] as string[],
      ...(typeof v["note"] === "string" && v["note"].trim() !== "" ? { note: v["note"] } : {}),
    },
  };
}

/** Progress evidence on report: an object when present, no gate shape yet. */
function checkReportEvidence(v: unknown): { error: string } | { value: Record<string, unknown> } {
  if (v === undefined) return { value: {} };
  if (!isRecord(v)) return { error: "evidence must be an object when present" };
  return { value: v };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function attemptStart(
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
    return { ok: false, error: "agent_id is required", hint: "pass the starting agent id" };
  }
  const reserved = reservedOwner(agentId);
  if (reserved) return reserved;
  const taskId = str(args, "task_id");
  if (!taskId) return { ok: false, error: "task_id is required", hint: "pass the task id" };

  return store.lock(`attempt-${teamId}-${taskId}`, async () => {
    const seat = await liveSeat(store, teamId, agentId);
    if ("error" in seat) return seat.error;
    const team = (await store.getTeam(teamId))!;
    const previous = await currentAttempt(store, team.id, taskId);
    const now = utcnowIso();
    const attempt: TaskAttemptRow = {
      attempt_id: str(args, "attempt_id") || newId("att"),
      team_id: team.id,
      task_id: taskId,
      attempt_no: (previous?.attempt_no ?? 0) + 1,
      seat: seat.seat,
      agent_id: agentId,
      status: "started",
      evidence: "{}",
      verifier_seat: "",
      verifier_agent: "",
      created_at: now,
      updated_at: now,
      decided_at: null,
    };
    await store.createTaskAttempt(attempt);
    // A new generation supersedes live older rows and invalidates their
    // tokens; terminal verdicts stay as history (store enforces that).
    const superseded = await store.supersedePriorAttempts(team.id, taskId, attempt.attempt_id, now);
    return {
      ok: true,
      attempt_id: attempt.attempt_id,
      attempt_no: attempt.attempt_no,
      task_id: taskId,
      seat: attempt.seat,
      agent_id: agentId,
      status: "started",
      superseded,
    };
  });
}

async function attemptReport(
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
    return { ok: false, error: "agent_id is required", hint: "pass the reporting agent id" };
  }
  const reserved = reservedOwner(agentId);
  if (reserved) return reserved;
  const attemptId = str(args, "attempt_id");
  if (!attemptId) {
    return {
      ok: false,
      error: "attempt_id is required",
      hint: "report against the attempt_id returned by task_attempt(action=start)",
    };
  }
  const summary = str(args, "summary") || str(args, "body");
  if (!summary) {
    return {
      ok: false,
      error: "summary is required",
      hint: "pass what was delivered; it becomes the task_report room message",
    };
  }

  return store.lock(`attempt-report-${attemptId}`, async () => {
    const seat = await liveSeat(store, teamId, agentId);
    if ("error" in seat) return seat.error;
    const team = (await store.getTeam(teamId))!;
    const attempt = await store.getTaskAttempt(attemptId);
    if (!attempt) {
      return {
        ok: false,
        error: `unknown attempt_id ${attemptId}`,
        hint: "start an attempt first with task_attempt(action=start)",
      };
    }
    if (attempt.team_id !== team.id) {
      return {
        ok: false,
        error: `attempt_id ${attemptId} is not on team ${team.id}`,
        hint: "attempt tokens are team-scoped; start one on this team",
      };
    }
    const current = await currentAttempt(store, team.id, attempt.task_id);
    const stale = staleToken(attemptId, current);
    if (stale) return stale;
    if (attempt.status !== "started") {
      return {
        ok: false,
        error: `attempt_id ${attemptId} is ${attempt.status}, not started`,
        hint:
          attempt.status === "delivered"
            ? "this attempt was already delivered; a verifier decides it next"
            : "this attempt is already decided; start a new one for rework",
      };
    }
    const evidence = checkReportEvidence(args["evidence"]);
    if ("error" in evidence)
      return { ok: false, error: evidence.error, hint: "pass evidence as an object" };

    const now = utcnowIso();
    const moved = await store.markAttemptDelivered(attemptId, JSON.stringify(evidence.value), now);
    if (!moved) {
      return {
        ok: false,
        error: `attempt_id ${attemptId} is no longer started`,
        hint: "read the current attempt and report against its token",
      };
    }
    const message = {
      id: newId("msg"),
      team_id: team.id,
      ts: now,
      author_seat: seat.seat,
      author_agent: agentId,
      kind: "task_report",
      task_id: attempt.task_id,
      attempt_id: attemptId,
      thread_root: "",
      mentions: [] as string[],
      body: summary,
      artifact_refs: [] as string[],
      correlation_id: "",
      discarded_at: null,
    };
    await store.postRoomMessage(message);
    const event = await appendRoomEvent(store, message);
    return { ok: true, attempt_id: attemptId, status: "delivered", message, event };
  });
}

async function attemptVerify(
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
      hint: "omit author_agent/author_seat; the verifier seat is resolved from agent_id via its live seat session",
    };
  }
  const agentId = str(args, "agent_id");
  if (!agentId) {
    return { ok: false, error: "agent_id is required", hint: "pass the verifying agent id" };
  }
  const reserved = reservedOwner(agentId);
  if (reserved) return reserved;
  const attemptId = str(args, "attempt_id");
  if (!attemptId) {
    return {
      ok: false,
      error: "attempt_id is required",
      hint: "verify the attempt_id from the task_report",
    };
  }
  const verdict = str(args, "verdict");
  if (!ATTEMPT_VERDICTS.includes(verdict)) {
    return {
      ok: false,
      error: `invalid verdict ${JSON.stringify(verdict)}`,
      hint: "must be one of: verified, rejected",
    };
  }

  return store.lock(`attempt-verify-${attemptId}`, async () => {
    const seat = await liveSeat(store, teamId, agentId);
    if ("error" in seat) return seat.error;
    const team = (await store.getTeam(teamId))!;
    const attempt = await store.getTaskAttempt(attemptId);
    if (!attempt) {
      return {
        ok: false,
        error: `unknown attempt_id ${attemptId}`,
        hint: "read the room's task_report messages for live attempt ids",
      };
    }
    if (attempt.team_id !== team.id) {
      return {
        ok: false,
        error: `attempt_id ${attemptId} is not on team ${team.id}`,
        hint: "attempt tokens are team-scoped",
      };
    }
    const current = await currentAttempt(store, team.id, attempt.task_id);
    const stale = staleToken(attemptId, current);
    if (stale) return stale;
    if (attempt.status !== "delivered") {
      return {
        ok: false,
        error: `attempt_id ${attemptId} is ${attempt.status}, not delivered`,
        hint:
          attempt.status === "started"
            ? "the worker must report delivery before verification"
            : "this attempt is already decided or superseded; verify the current one",
      };
    }
    // A verifier cannot verify their own attempt: the seat is the identity
    // (#70), and the agent check covers a seat-hopper verifying their own
    // work from a second seat.
    if (seat.seat === attempt.seat || agentId === attempt.agent_id) {
      return {
        ok: false,
        error: `seat ${seat.seat} cannot verify its own attempt ${attemptId}`,
        hint: "verification needs a second seat; the worker's own report is not a verdict",
      };
    }

    let evidenceJson = "{}";
    let summary: string;
    if (verdict === "verified") {
      const checked = checkVerifyEvidence(args["evidence"]);
      if ("error" in checked) {
        return {
          ok: false,
          error: `verified without evidence: ${checked.error}`,
          hint: "pass evidence {acceptanceResults (non-empty), commandsRun, changedPaths}",
        };
      }
      evidenceJson = JSON.stringify(checked.value);
      summary = str(args, "summary") || `verified attempt ${attemptId} for task ${attempt.task_id}`;
    } else {
      const reason = str(args, "reason");
      if (!reason) {
        return {
          ok: false,
          error: "reason is required to reject",
          hint: "pass why the delivery fails; the worker reworks from it",
        };
      }
      if (args["evidence"] !== undefined) {
        const checked = checkReportEvidence(args["evidence"]);
        if ("error" in checked) {
          return { ok: false, error: checked.error, hint: "pass evidence as an object" };
        }
        evidenceJson = JSON.stringify({ ...checked.value, reason });
      } else {
        evidenceJson = JSON.stringify({ reason });
      }
      summary = str(args, "summary") || reason;
    }

    const now = utcnowIso();
    const decided = await store.decideAttempt(
      attemptId,
      verdict as "verified" | "rejected",
      evidenceJson,
      seat.seat,
      agentId,
      now,
    );
    if (!decided) {
      return {
        ok: false,
        error: `attempt_id ${attemptId} is no longer delivered`,
        hint: "another verifier may have decided it; read the current attempt",
      };
    }
    const message = {
      id: newId("msg"),
      team_id: team.id,
      ts: now,
      author_seat: seat.seat,
      author_agent: agentId,
      kind: verdict === "verified" ? "task_verified" : "task_rejected",
      task_id: attempt.task_id,
      attempt_id: attemptId,
      thread_root: "",
      mentions: [] as string[],
      body: summary,
      artifact_refs: [] as string[],
      correlation_id: "",
      discarded_at: null,
    };
    await store.postRoomMessage(message);
    const event = await appendRoomEvent(store, message);
    return {
      ok: true,
      attempt_id: attemptId,
      status: verdict,
      verifier_seat: seat.seat,
      message,
      event,
    };
  });
}

// ---------------------------------------------------------------------------
// Dependency gate — wiring into the ledger scheduler is OUT OF SCOPE (T2);
// this is the predicate the scheduler will call.
// ---------------------------------------------------------------------------

/**
 * True only when the task's CURRENT attempt is verified. `delivered` is a
 * claim, not a gate: only a verifier's verdict unlocks dependents.
 */
export async function currentAttemptIsVerified(
  store: Store,
  teamId: string,
  taskId: string,
): Promise<boolean> {
  const current = await store.getCurrentTaskAttempt(teamId, taskId);
  return current?.status === "verified";
}

/**
 * A task may start only when every dependency task's current attempt is
 * verified. Dependencies are caller-supplied: orch_tasks rows carry no
 * dependency edges, so there is nothing to read them from — the scheduler
 * (out of scope for T2) passes the dep list it owns. No attempts at all on
 * a dependency counts as blocked, never as vacuous pass.
 */
export async function dependenciesSatisfied(
  store: Store,
  teamId: string,
  taskId: string,
  dependencies: string[],
): Promise<{ task_id: string; satisfied: boolean; blocked: string[] }> {
  const blocked: string[] = [];
  for (const dep of dependencies) {
    if (!(await currentAttemptIsVerified(store, teamId, dep))) blocked.push(dep);
  }
  return { task_id: taskId, satisfied: blocked.length === 0, blocked };
}

// ---------------------------------------------------------------------------
// Tool spec
// ---------------------------------------------------------------------------

const taskAttemptSpec: ToolSpec = {
  // Lean wire shape, matching the base snapshot convention (one-line tool
  // description, no per-property descriptions): every tier's tools/list
  // payload counts against the 2000-token budget. Semantics live in the
  // run() errors and in #70, not in the schema text.
  name: "task_attempt",
  description: "Task attempts (#70 T2): start/report/verify a task's execution generations.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["start", "report", "verify"],
      },
      team: { type: "string" },
      team_id: { type: "string" },
      agent_id: { type: "string" },
      task_id: { type: "string" },
      attempt_id: { type: "string" },
      summary: { type: "string" },
      body: { type: "string" },
      verdict: { type: "string" },
      reason: { type: "string" },
      evidence: { type: "object" },
      author_agent: { type: "string" },
      author_seat: { type: "string" },
    },
    required: ["action"],
  },
  run: (store, args) => runTaskAttemptTool(store, args),
};

/**
 * The action dispatch, shared by the MCP tool and any future HTTP path so
 * both surfaces answer identically.
 */
export function runTaskAttemptTool(
  store: Store,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = str(args, "action", "");
  if (action === "start") return attemptStart(store, args);
  if (action === "report") return attemptReport(store, args);
  if (action === "verify") return attemptVerify(store, args);
  return Promise.resolve({
    ok: false,
    error: `invalid action ${JSON.stringify(action)}`,
    hint: "must be one of: start, report, verify",
  });
}

export const TASK_ATTEMPT_DOMAIN: ToolDomain = {
  namespace: "team",
  tools: [taskAttemptSpec],
};
