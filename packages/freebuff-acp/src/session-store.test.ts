import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadPersistedSession,
  pruneEmptyPersistedSessions,
  savePersistedSession,
  slimRunState,
} from "./session-store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function runStateWith(messageHistory: unknown[]): Record<string, unknown> {
  return { fileContext: {}, mainAgentState: { messageHistory } };
}

const twoTurns = [
  { role: "user", content: [{ type: "text", text: "q1" }] },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "old thinking" },
      { type: "text", text: "a1" },
    ],
  },
  { role: "assistant", content: [{ type: "reasoning", text: "only thinking" }] },
  { role: "user", content: [{ type: "text", text: "q2" }] },
  { role: "assistant", content: [{ type: "reasoning", text: "latest thinking" }] },
];

describe("slimRunState", () => {
  it("drops reasoning from earlier turns but keeps the latest turn intact", () => {
    const slimmed = slimRunState(runStateWith(twoTurns)) as {
      mainAgentState: { messageHistory: { content: { type: string }[] }[] };
    };
    const history = slimmed.mainAgentState.messageHistory;
    const partTypes = (message: { content: { type: string }[] }): string[] =>
      message.content.map((part) => part.type);
    expect(history.map(partTypes)).toEqual([["text"], ["text"], ["text"], ["reasoning"]]);
  });

  it("does not modify the live RunState", () => {
    const live = runStateWith(twoTurns);
    slimRunState(live);
    expect(JSON.stringify(live)).toContain("old thinking");
  });

  it("passes through null and state without a history", () => {
    expect(slimRunState(null)).toBeNull();
    expect(slimRunState({ fileContext: {} })).toEqual({ fileContext: {} });
  });
});

describe("session persistence", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-store-"));
    env = { FREEBUFF_ACP_STATE_DIR: stateDir };
  });
  afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  const base = { cwd: "/tmp/x", modeId: "lite", updatedAt: "" };

  it("saves a slimmed RunState and leaves no temp files", () => {
    savePersistedSession({ ...base, sessionId: "s1", runState: runStateWith(twoTurns) }, env);
    const raw = fs.readFileSync(path.join(stateDir, "s1.json"), "utf8");
    expect(raw).not.toContain("old thinking");
    expect(raw).toContain("latest thinking");
    expect(fs.readdirSync(stateDir)).toEqual(["s1.json"]);
    expect(loadPersistedSession("s1", env)?.runState).not.toBeNull();
  });

  it("prunes day-old sessions without a RunState and keeps everything else", () => {
    savePersistedSession({ ...base, sessionId: "empty-old", runState: null }, env);
    savePersistedSession({ ...base, sessionId: "empty-new", runState: null }, env);
    savePersistedSession({ ...base, sessionId: "real", runState: runStateWith(twoTurns) }, env);
    const oldFile = path.join(stateDir, "empty-old.json");
    const record = JSON.parse(fs.readFileSync(oldFile, "utf8"));
    record.updatedAt = new Date(Date.now() - 2 * DAY_MS).toISOString();
    fs.writeFileSync(oldFile, JSON.stringify(record));

    expect(pruneEmptyPersistedSessions(env)).toBe(1);
    expect(fs.readdirSync(stateDir).sort()).toEqual(["empty-new.json", "real.json"]);
  });
});
