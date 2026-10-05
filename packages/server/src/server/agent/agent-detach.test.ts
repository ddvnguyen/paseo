import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { asInternals } from "../test-utils/class-mocks.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  __resetAgentDetachForTests,
  beginAgentDetachStop,
  isAgentDetachStopActive,
  isDetachAgentsOnStopEnabled,
  shouldDetachAgentProcess,
} from "./agent-detach.js";
import {
  flushLiveAgentProcesses,
  isPidAlive,
  readAgentProcessRegistry,
  recordAgentProcess,
  setAgentProcessRegistryHome,
} from "./agent-process-registry.js";
import { ACPAgentSession } from "./providers/acp-agent.js";

const logger = createTestLogger();

interface DetachACPInternals {
  child: ChildProcess | null;
  connection: {
    cancel: ReturnType<typeof vi.fn>;
    unstable_closeSession: ReturnType<typeof vi.fn>;
  } | null;
  sessionId: string | null;
  activeForegroundTurnId: string | null;
  agentCapabilities: { sessionCapabilities?: { close?: boolean } } | null;
}

function createSession(): ACPAgentSession {
  return new ACPAgentSession(
    { provider: "generic-acp", cwd: "/tmp/paseo-detach-test" },
    {
      provider: "generic-acp",
      logger,
      defaultCommand: ["detached-acp", "acp"],
      defaultModes: [],
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
    },
  );
}

function spawnRealChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function registerChild(child: ChildProcess): number {
  const pid = child.pid;
  expect(typeof pid).toBe("number");
  recordAgentProcess(
    {
      scopeId: `paseo-agent-test-${pid}`,
      unit: `paseo-agent-test-${pid}.scope`,
      pid: pid as number,
      provider: "generic-acp",
      startedAt: new Date().toISOString(),
    },
    { logger },
  );
  return pid as number;
}

function attachChild(session: ACPAgentSession, child: ChildProcess): DetachACPInternals {
  const internals = asInternals<DetachACPInternals>(session);
  internals.child = child;
  internals.connection = {
    cancel: vi.fn().mockResolvedValue(undefined),
    unstable_closeSession: vi.fn().mockResolvedValue(undefined),
  };
  internals.sessionId = "session-detach-1";
  internals.activeForegroundTurnId = "turn-detach-1";
  internals.agentCapabilities = { sessionCapabilities: { close: true } };
  return internals;
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

describe("agent detach flag", () => {
  let tmpDir: string;
  let previousDetachEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-detach-"));
    setAgentProcessRegistryHome(tmpDir);
    previousDetachEnv = process.env.PASEO_DETACH_AGENTS_ON_STOP;
    delete process.env.PASEO_DETACH_AGENTS_ON_STOP;
    __resetAgentDetachForTests();
  });

  afterEach(() => {
    __resetAgentDetachForTests();
    setAgentProcessRegistryHome(null);
    if (previousDetachEnv === undefined) {
      delete process.env.PASEO_DETACH_AGENTS_ON_STOP;
    } else {
      process.env.PASEO_DETACH_AGENTS_ON_STOP = previousDetachEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("is disabled by default and a default stop does not engage detach", () => {
    expect(isDetachAgentsOnStopEnabled()).toBe(false);
    expect(beginAgentDetachStop(logger)).toBe(false);
    expect(isAgentDetachStopActive()).toBe(false);
  });

  test("PASEO_DETACH_AGENTS_ON_STOP=1 and =true enable detach; 0 does not", () => {
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    expect(isDetachAgentsOnStopEnabled()).toBe(true);
    expect(beginAgentDetachStop(logger)).toBe(true);
    expect(isAgentDetachStopActive()).toBe(true);

    __resetAgentDetachForTests();
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "true";
    expect(isDetachAgentsOnStopEnabled()).toBe(true);

    __resetAgentDetachForTests();
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "0";
    expect(isDetachAgentsOnStopEnabled()).toBe(false);
    expect(beginAgentDetachStop(logger)).toBe(false);
    expect(isAgentDetachStopActive()).toBe(false);
  });

  test("begin is idempotent once engaged", () => {
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    expect(beginAgentDetachStop(logger)).toBe(true);
    expect(beginAgentDetachStop(logger)).toBe(true);
    expect(isAgentDetachStopActive()).toBe(true);
  });

  test("shouldDetachAgentProcess only matches registry entries while a detach-stop runs", () => {
    recordAgentProcess(
      {
        scopeId: "paseo-agent-unit-1",
        unit: "paseo-agent-unit-1.scope",
        pid: 4242,
        provider: "opencode",
        startedAt: new Date().toISOString(),
      },
      { logger },
    );

    // Detach not engaged: never consults the child (default stop = today's behaviour).
    expect(shouldDetachAgentProcess(4242)).toBe(false);

    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    expect(beginAgentDetachStop(logger)).toBe(true);
    expect(shouldDetachAgentProcess(4242)).toBe(true);
    // Registered for someone else / never recorded: terminate as usual.
    expect(shouldDetachAgentProcess(4243)).toBe(false);
    expect(shouldDetachAgentProcess(null)).toBe(false);
    expect(shouldDetachAgentProcess(undefined)).toBe(false);
    expect(shouldDetachAgentProcess(-1)).toBe(false);
  });
});

describe("detach stop vs normal stop with a real child", () => {
  let tmpDir: string;
  let previousDetachEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-detach-stop-"));
    setAgentProcessRegistryHome(tmpDir);
    previousDetachEnv = process.env.PASEO_DETACH_AGENTS_ON_STOP;
    delete process.env.PASEO_DETACH_AGENTS_ON_STOP;
    __resetAgentDetachForTests();
  });

  afterEach(() => {
    __resetAgentDetachForTests();
    setAgentProcessRegistryHome(null);
    if (previousDetachEnv === undefined) {
      delete process.env.PASEO_DETACH_AGENTS_ON_STOP;
    } else {
      process.env.PASEO_DETACH_AGENTS_ON_STOP = previousDetachEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("detach-stop skips provider cancel/closeSession/terminate and the scoped child survives", async () => {
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    expect(beginAgentDetachStop(logger)).toBe(true);

    const child = spawnRealChild();
    const pid = registerChild(child);
    const session = createSession();
    const internals = attachChild(session, child);
    // close() nulls internals.connection on its way out; assert on our reference.
    const connection = internals.connection as NonNullable<DetachACPInternals["connection"]>;

    try {
      await session.close();

      expect(connection.cancel).not.toHaveBeenCalled();
      expect(connection.unstable_closeSession).not.toHaveBeenCalled();
      expect(internals.child).toBeNull();

      // The child is untouched: still alive after the session closed.
      expect(isPidAlive(pid)).toBe(true);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();

      // The registry still carries the survivor, and the detach-stop flush
      // keeps it on disk for the next daemon.
      const entries = readAgentProcessRegistry({ logger });
      expect(entries.map((entry) => entry.pid)).toContain(pid);
      const flush = flushLiveAgentProcesses({ logger });
      expect(flush.kept.map((entry) => entry.pid)).toContain(pid);
      expect(flush.removed).toEqual([]);
    } finally {
      await killAndWait(child);
      // The dead child's record is then flushable.
      const flush = flushLiveAgentProcesses({ logger });
      expect(flush.removed.map((entry) => entry.pid)).toContain(pid);
    }
  });

  test("normal stop cancels, closes the session, and terminates the child as today", async () => {
    expect(beginAgentDetachStop(logger)).toBe(false);

    const child = spawnRealChild();
    const pid = registerChild(child);
    const session = createSession();
    const internals = attachChild(session, child);
    const connection = internals.connection as NonNullable<DetachACPInternals["connection"]>;

    await session.close();

    expect(connection.cancel).toHaveBeenCalledWith({
      sessionId: "session-detach-1",
    });
    expect(connection.unstable_closeSession).toHaveBeenCalledWith({
      sessionId: "session-detach-1",
    });
    expect(child.exitCode === null && child.signalCode === null).toBe(false);

    // The flush drops the now-dead pid instead of advertising it as a survivor.
    const flush = flushLiveAgentProcesses({ logger });
    expect(flush.removed.map((entry) => entry.pid)).toContain(pid);
    expect(flush.kept.map((entry) => entry.pid)).not.toContain(pid);
  });

  test("detach-stop still tears down children outside the scope registry", async () => {
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    expect(beginAgentDetachStop(logger)).toBe(true);

    // Never recorded: unscoped children cannot be adopted, so they keep
    // today's teardown even while detach is engaged.
    const child = spawnRealChild();
    const session = createSession();
    const internals = attachChild(session, child);
    const connection = internals.connection as NonNullable<DetachACPInternals["connection"]>;

    await session.close();

    expect(connection.cancel).toHaveBeenCalled();
    expect(connection.unstable_closeSession).toHaveBeenCalled();
    expect(child.exitCode === null && child.signalCode === null).toBe(false);
  });
});
