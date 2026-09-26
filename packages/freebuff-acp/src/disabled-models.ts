import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { sessionsStateDir } from "./session-store.js";

/**
 * Global per-adapter disabled-models store: which catalog models the host
 * must no longer offer for NEW selection. ONE file next to the session
 * files (not per account — the catalog is adapter-wide), written atomically
 * (temp file + rename, mode 0600) like the session store.
 *
 * Sessions already running on a disabled model keep running; only new
 * selection (newSession / setSessionModel) is blocked.
 */

const STORE_FILE = "disabled-models.json";

export function disabledModelsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(sessionsStateDir(env), STORE_FILE);
}

/** Disabled catalog model ids; [] when the store is missing or unreadable. Never throws. */
export function readDisabledModels(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(disabledModelsFilePath(env), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/**
 * Enable or disable one catalog model. Unknown ids are rejected, and the
 * last enabled model cannot be disabled (the host must always offer one).
 * Returns the new disabled list, sorted.
 */
export function setModelEnabled(
  modelId: string,
  enabled: boolean,
  validIds: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): { disabled: string[] } {
  if (!validIds.has(modelId)) throw new Error(`Unknown model: ${modelId}`);
  const next = new Set(readDisabledModels(env));
  if (enabled) {
    next.delete(modelId);
  } else {
    next.add(modelId);
  }
  const remaining = [...validIds].filter((id) => !next.has(id));
  if (remaining.length === 0) {
    throw new Error(`Cannot disable "${modelId}": at least one model must stay enabled.`);
  }
  const disabled = [...next].sort();
  const file = disabledModelsFilePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(disabled, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { disabled };
}
