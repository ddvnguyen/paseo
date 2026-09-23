/**
 * Drive the adapter exactly as paseo's GenericACPAgentClient would, across a
 * hard process restart:
 *
 * Phase 1: initialize -> session/new -> session/prompt (codeword AXIOM)
 *          -> SIGKILL the adapter -> verify the on-disk state file.
 * Phase 2: spawn a fresh adapter -> initialize -> session/resume
 *          (wire method proven from the SDK: AGENT_METHODS.session_resume
 *           = "session/resume", dist/schema/index.js) -> session/prompt
 *          asking for the codeword; AXIOM in the response = context survived.
 *
 * Exit codes: 0 = full pass (AXIOM recovered)
 *             3 = quota/waiting-room refusal (QUOTA-BLOCKED banner)
 *             1 = any other failure (resume rejected, timeout, crash)
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CMD = process.env.ACP_CMD ?? "node";
const ARGS = (process.env.ACP_ARGS ?? "dist/entry.js").split(" ");
const CWD = process.env.ACP_CWD ?? "/tmp";
const QUOTA_SIGNATURE = "Freebuff is busy right now (waiting room)";
const REQUEST_TIMEOUT_MS = 120_000;

interface Adapter {
  proc: ChildProcess;
  send(method: string, params: unknown): Promise<unknown>;
  resetMessageText(): void;
  messageText(): string;
  killHard(): Promise<number | null>;
  exitCode(): number | null;
}

/** Spawn one adapter process and return the send/capture scaffolding. */
function createAdapter(label: string): Adapter {
  const proc = spawn(CMD, ARGS, { stdio: ["pipe", "pipe", "pipe"] });
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }
  >();
  let buf = "";
  let text = "";

  function send(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    proc.stdin!.write(JSON.stringify(msg) + "\n");
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);
    });
  }

  proc.stdout!.on("data", (d: Buffer) => {
    buf += d;
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      processLine(line, pending, (chunk) => {
        text += chunk;
      });
    }
  });
  proc.stderr!.on("data", (d: Buffer) =>
    console.error(`[${label} stderr]`, d.toString().slice(0, 300)),
  );
  proc.on("exit", (code) => console.log(`[${label} exit]`, code));

  return {
    proc,
    send,
    resetMessageText: () => {
      text = "";
    },
    messageText: () => text,
    killHard: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          resolve(proc.exitCode);
          return;
        }
        proc.once("exit", (code) => resolve(code));
        proc.kill("SIGKILL");
      }),
    exitCode: () => proc.exitCode,
  };
}

type PendingRequests = Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }
>;

/** Route one ndjson line: JSON-RPC response → pending map; method → notification. */
function processLine(
  line: string,
  pending: PendingRequests,
  onChunk: (chunk: string) => void,
): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log("NON-JSON STDOUT:", line.slice(0, 200));
    return;
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const entry = pending.get(msg.id as number);
    if (entry) {
      pending.delete(msg.id as number);
      if (msg.error) entry.reject(new Error(`${entry.method}: ${JSON.stringify(msg.error)}`));
      else entry.resolve(msg.result);
    }
    return;
  }
  if (msg.method) dispatchNotification(msg, onChunk);
}

/** Log/stream one ACP notification (chunk text accumulates via onChunk). */
function dispatchNotification(
  msg: Record<string, unknown>,
  onChunk: (chunk: string) => void,
): void {
  const upd =
    (msg.params as Record<string, unknown> | undefined)?.update ??
    (msg.params as Record<string, unknown> | undefined) ??
    {};
  const kind =
    (msg.params as { update?: { sessionUpdate?: string }; sessionUpdate?: string }).update
      ?.sessionUpdate ??
    (msg.params as { sessionUpdate?: string }).sessionUpdate ??
    msg.method;
  if (kind === "agent_message_chunk") {
    const chunkText = (upd as { content?: { text?: string } }).content?.text ?? JSON.stringify(upd);
    onChunk(chunkText);
    process.stdout.write("[text]" + chunkText.slice(0, 120));
  } else if (kind === "agent_thought_chunk") {
    process.stdout.write("[think]");
  } else if (kind === "tool_call" || kind === "tool_call_update") {
    console.log(
      `[tool:${
        (upd as { title?: string; toolCallId?: string }).title ??
        (upd as { toolCallId?: string }).toolCallId ??
        "?"
      } ${(upd as { status?: string }).status ?? ""}]`,
    );
  } else {
    console.log(`[${msg.method}]`, JSON.stringify(msg.params).slice(0, 200));
  }
}

/** Resolve the state file path exactly like src/session-store.ts. */
function sessionFilePath(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FREEBUFF_ACP_STATE_DIR?.trim();
  const xdg = env.XDG_STATE_HOME?.trim();
  let dir: string;
  if (configured && path.isAbsolute(configured)) {
    dir = configured;
  } else if (xdg && path.isAbsolute(xdg)) {
    dir = path.join(xdg, "freebuff-acp", "sessions");
  } else {
    dir = path.join(os.homedir(), ".local", "state", "freebuff-acp", "sessions");
  }
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return path.join(dir, `${safe}.json`);
}

function fail(message: string): never {
  console.error("\nFAIL:", message);
  process.exit(1);
}

function isQuotaBlocked(text: string, stopReason: unknown): boolean {
  if (text.includes(QUOTA_SIGNATURE)) return true;
  return stopReason === "refusal" && text.includes("waiting room");
}

async function initialize(adapter: Adapter): Promise<Record<string, unknown>> {
  const init = (await adapter.send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  })) as Record<string, unknown>;
  console.log("initialized, protocolVersion:", init.protocolVersion);
  const caps = (init.agentCapabilities ?? {}) as Record<string, unknown>;
  console.log("agentCapabilities:", JSON.stringify(caps).slice(0, 300));
  return init;
}

async function runPrompt(
  adapter: Adapter,
  sessionId: string,
  promptText: string,
): Promise<{ stopReason: unknown; text: string }> {
  adapter.resetMessageText();
  const result = (await adapter.send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: promptText }],
  })) as { stopReason?: unknown };
  console.log("\nprompt result:", JSON.stringify(result));
  return { stopReason: result.stopReason, text: adapter.messageText() };
}

// ---------------------------------------------------------------------------
// Phase 1: initialize -> session/new -> prompt codeword -> SIGKILL
// ---------------------------------------------------------------------------
console.log("=== Phase 1: fresh session + codeword prompt ===");
const phase1 = createAdapter("phase1");
await initialize(phase1);
const session = (await phase1.send("session/new", {
  cwd: CWD,
  mcpServers: [],
})) as { sessionId?: string };
console.log("session/new ok:", JSON.stringify(session).slice(0, 200));
if (!session.sessionId) fail("session/new returned no sessionId");
const sessionId = session.sessionId;

const p1 = await runPrompt(phase1, sessionId, "Remember this codeword: AXIOM. Reply OK.");
console.log("phase-1 stopReason:", p1.stopReason);
const phase1Quota = isQuotaBlocked(p1.text, p1.stopReason);

const killCode = await phase1.killHard();
console.log("phase-1 hard-killed, exit code:", killCode);

// ---------------------------------------------------------------------------
// State-file check (resolved exactly like src/session-store.ts)
// ---------------------------------------------------------------------------
const stateFile = sessionFilePath(sessionId);
const stateExists = fs.existsSync(stateFile);
let runStatePresent: boolean | null = null;
let stateUpdatedAt = "";
if (stateExists) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      runState?: unknown;
      updatedAt?: string;
    };
    runStatePresent =
      parsed.runState !== null &&
      parsed.runState !== undefined &&
      typeof parsed.runState === "object";
    stateUpdatedAt = parsed.updatedAt ?? "";
  } catch (e) {
    fail(`state file exists but failed to parse: ${String(e)}`);
  }
}
console.log("\nstate file:", stateFile);
console.log("state file exists:", stateExists);
console.log("state file runState present:", runStatePresent);
console.log("state file updatedAt:", stateUpdatedAt || "(none)");

// ---------------------------------------------------------------------------
// Phase 2: fresh adapter -> session/resume -> codeword recall prompt
// ---------------------------------------------------------------------------
console.log("\n=== Phase 2: fresh adapter + session/resume ===");
const phase2 = createAdapter("phase2");
await initialize(phase2);

let resumeOk = false;
let resumeError = "";
try {
  const resumed = await phase2.send("session/resume", {
    sessionId,
    cwd: CWD,
    mcpServers: [],
  });
  resumeOk = true;
  console.log("session/resume ok:", JSON.stringify(resumed).slice(0, 300));
} catch (e) {
  resumeError = e instanceof Error ? e.message : String(e);
  console.error("session/resume FAILED:", resumeError);
}

if (!resumeOk) {
  console.log("\n=== REPORT ===");
  console.log("phase-1 stopReason:", p1.stopReason);
  console.log("state file exists:", stateExists, "runState present:", runStatePresent);
  console.log("resume: FAILED —", resumeError);
  console.log("phase-2 stopReason: (skipped — resume rejected)");
  console.log("AXIOM recovered: no");
  process.exit(1);
}

const p2 = await runPrompt(phase2, sessionId, "What codeword did I ask you to remember?");

const axiomRecovered = p2.text.includes("AXIOM");
const phase2Quota = isQuotaBlocked(p2.text, p2.stopReason);
const quotaBlocked = phase1Quota || phase2Quota;

phase2.proc.kill();

console.log("\n=== REPORT ===");
console.log("phase-1 stopReason:", p1.stopReason);
console.log("state file exists:", stateExists, "runState present:", runStatePresent);
console.log("resume: ok");
console.log("phase-2 stopReason:", p2.stopReason);
console.log("phase-2 response:", JSON.stringify(p2.text.slice(0, 500)));
console.log("AXIOM recovered:", axiomRecovered);

if (quotaBlocked) {
  console.log("QUOTA-BLOCKED: rerun after freebucks reset");
  process.exit(3);
}
if (axiomRecovered) {
  console.log("PASS: context survived restart");
  process.exit(0);
}
console.log("FAIL: AXIOM not found in phase-2 response (context lost or wrong answer)");
process.exit(1);
