/**
 * On-disk persistence for freebuff-acp adapter sessions.
 *
 * ACP hosts (Paseo) keep a persistence handle of `sessionId` and call
 * `session/resume` after the adapter process restarts. Conversation state is
 * an SDK `RunState` JSON blob — plain data — so it can be written under a
 * state directory and rehydrated on resume instead of blocking the host with
 * "session not supported".
 *
 * State root (first match wins):
 *   1. `FREEBUFF_ACP_STATE_DIR` (absolute path; tests override this)
 *   2. `$XDG_STATE_HOME/freebuff-acp/sessions`
 *   3. `~/.local/state/freebuff-acp/sessions`
 *
 * Failures are non-fatal: save/load swallow IO errors so a full disk or
 * missing home never breaks a live turn.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PersistedFreebuffSession {
  sessionId: string;
  cwd: string;
  modeId: string;
  /** Catalog model the session last ran on (absent in files from older builds). */
  modelId?: string;
  /** Whether opening a new session needs host approval ("ask" | "auto"). */
  confirmOpen?: string;
  /** Registered account the session runs under (absent = default account). */
  accountId?: string;
  /** Short conversation title derived from the first prompt. */
  title?: string;
  runState: Record<string, unknown> | null;
  updatedAt: string;
}

export function sessionsStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FREEBUFF_ACP_STATE_DIR?.trim();
  if (configured && path.isAbsolute(configured)) {
    return configured;
  }
  const xdg = env.XDG_STATE_HOME?.trim();
  const base =
    xdg && path.isAbsolute(xdg)
      ? path.join(xdg, "freebuff-acp", "sessions")
      : path.join(os.homedir(), ".local", "state", "freebuff-acp", "sessions");
  return base;
}

function sessionFilePath(env: NodeJS.ProcessEnv, sessionId: string): string {
  // Session ids are minted by this adapter (`freebuff-…`); still sanitize so a
  // hostile id cannot escape the state directory.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return path.join(sessionsStateDir(env), `${safe}.json`);
}

interface HistoryMessage {
  role?: unknown;
  content?: unknown;
}

function isReasoningPart(part: unknown): boolean {
  return (
    typeof part === "object" && part !== null && (part as { type?: unknown }).type === "reasoning"
  );
}

/**
 * Drops reasoning parts from every turn except the latest one. Old reasoning
 * dominates session size (a single message can be >100 KB) and is not needed
 * to continue a conversation. Returns a copy; the live in-memory RunState is
 * never modified.
 */
export function slimRunState(
  runState: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const mainAgentState = runState?.mainAgentState as { messageHistory?: unknown } | undefined;
  const history = mainAgentState?.messageHistory;
  if (!runState || !mainAgentState || !Array.isArray(history)) return runState;

  const messages = history as HistoryMessage[];
  const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
  const slimmed = messages.flatMap((message, index) => {
    if (index >= lastUserIndex || message.role !== "assistant" || !Array.isArray(message.content)) {
      return [message];
    }
    const content = message.content.filter((part) => !isReasoningPart(part));
    if (content.length === message.content.length) return [message];
    return content.length > 0 ? [{ ...message, content }] : [];
  });
  return { ...runState, mainAgentState: { ...mainAgentState, messageHistory: slimmed } };
}

/** Sessions that never ran a turn and are older than this are junk. */
const EMPTY_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Removes session files that hold no conversation (no RunState) once they are
 * a day old. Host probes and abandoned drafts create these; they only add
 * noise to session/list. Best-effort like every store operation.
 */
export function pruneEmptyPersistedSessions(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): number {
  let removed = 0;
  try {
    const dir = sessionsStateDir(env);
    if (!fs.existsSync(dir)) return 0;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const sessionId = entry.slice(0, -".json".length);
      const session = loadPersistedSession(sessionId, env);
      if (!session || session.runState !== null) continue;
      const updatedAt = Date.parse(session.updatedAt);
      if (Number.isNaN(updatedAt) || now - updatedAt < EMPTY_SESSION_MAX_AGE_MS) continue;
      fs.rmSync(path.join(dir, entry), { force: true });
      removed += 1;
    }
  } catch {
    // Best-effort cleanup.
  }
  return removed;
}

export function savePersistedSession(
  session: PersistedFreebuffSession,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const file = sessionFilePath(env, session.sessionId);
    // RunState carries conversation content; keep it off other local users.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write to a temp file then rename: a crash mid-write must never leave a
    // truncated session file that would lose the whole conversation.
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({
        ...session,
        runState: slimRunState(session.runState),
        updatedAt: new Date().toISOString(),
      }),
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    fs.renameSync(temporary, file);
  } catch {
    // Best-effort; resume degrades to a fresh conversation context.
  }
}

export function loadPersistedSession(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): PersistedFreebuffSession | null {
  try {
    const file = sessionFilePath(env, sessionId);
    if (!fs.existsSync(file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<PersistedFreebuffSession>;
    if (typeof record.sessionId !== "string" || record.sessionId !== sessionId) return null;
    if (typeof record.cwd !== "string") return null;
    return {
      sessionId: record.sessionId,
      cwd: record.cwd,
      modeId: typeof record.modeId === "string" ? record.modeId : "lite",
      ...(typeof record.modelId === "string" ? { modelId: record.modelId } : {}),
      ...(typeof record.confirmOpen === "string" ? { confirmOpen: record.confirmOpen } : {}),
      ...(typeof record.accountId === "string" ? { accountId: record.accountId } : {}),
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      runState:
        record.runState && typeof record.runState === "object"
          ? (record.runState as Record<string, unknown>)
          : null,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Persisted sessions, newest first, optionally limited to one workspace.
 * Feeds ACP `session/list` so hosts can offer to resume/import past sessions.
 */
export function listPersistedSessions(
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string | null,
): PersistedFreebuffSession[] {
  try {
    const dir = sessionsStateDir(env);
    if (!fs.existsSync(dir)) return [];
    const sessions: PersistedFreebuffSession[] = [];
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const sessionId = entry.slice(0, -".json".length);
      const session = loadPersistedSession(sessionId, env);
      if (session && (!cwd || session.cwd === cwd)) sessions.push(session);
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}
