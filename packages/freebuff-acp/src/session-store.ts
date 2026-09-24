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

export function savePersistedSession(
  session: PersistedFreebuffSession,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const file = sessionFilePath(env, session.sessionId);
    // RunState carries conversation content; keep it off other local users.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ ...session, updatedAt: new Date().toISOString() }), {
      encoding: "utf8",
      mode: 0o600,
    });
    // `mode` above only applies when the file is newly created; correct an
    // existing file's permissions too (e.g. left behind by an older build).
    fs.chmodSync(file, 0o600);
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
