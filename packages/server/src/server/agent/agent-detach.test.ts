import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { asInternals } from "../test-utils/class-mocks.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  DETACH_AGENTS_ON_STOP_ENV,
  DAEMON_STOP_CLOSE_REASON,
  isDetachAgentsOnStopEnabled,
  logDetachOnStopConfigured,
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

describe("agent detach configuration", () => {
  let previousDetachEnv: string | undefined;

  beforeEach(() => {
    previousDetachEnv = process.env[DETACH_AGENTS_ON_STOP_ENV];
    delete process.env[DETACH_AGENTS_ON_STOP_ENV];
  });

  afterEach(() => {
    if (previousDetachEnv === undefined) {
      delete process.env[DETACH_AGENTS_ON_STOP_ENV];
    } else {
      process.env[DETACH_AGENTS_ON_STOP_ENV] = previousDetachEnv;
    }
  });

  test("is disabled by default", () => {
    expect(isDetachAgentsOnStopEnabled()).toBe(false);
  });

  test("PASEO_DETACH_AGENTS_ON_STOP=1 and =true enable detach; 0 does not", () => {
    process.env[DETACH_AGENTS_ON_STOP_ENV] = "1";
    expect(isDetachAgentsOnStopEnabled()).toBe(true);

    process.env[DETACH_AGENTS_ON_STOP_ENV] = "true";
    expect(isDetachAgentsOnStopEnabled()).toBe(true);

    process.env[DETACH_AGENTS_ON_STOP_ENV] = "0";
    expect(isDetachAgentsOnStopEnabled()).toBe(false);
  });

  test("logDetachOnStopConfigured only logs when the env opt-in is on", () => {
    const silent = { info: vi.fn() } as unknown as Parameters<typeof logDetachOnStopConfigured>[0];
    logDetachOnStopConfigured(silent);
    expect(silent.info).not.toHaveBeenCalled();

    process.env[DETACH_AGENTS_ON_STOP_ENV] = "1";
    const loud = { info: vi.fn() } as unknown as Parameters<typeof logDetachOnStopConfigured>[0];
    logDetachOnStopConfigured(loud);
    expect(loud.info).toHaveBeenCalledTimes(1);
  });
});

/**
 * The gate itself. Detach intent is a property of the CLOSE CALL, never of the
 * process, so there is deliberately no mutable module state here to reset
 * between tests — that absence is the point of the fix.
 */
describe("shouldDetachAgentProcess is call-scoped", () => {
  let tmpDir: string;
  let previousDetachEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-detach-gate-"));
    setAgentProcessRegistryHome(tmpDir);
    previousDetachEnv = process.env[DETACH_AGENTS_ON_STOP_ENV];
    delete process.env[DETACH_AGENTS_ON_STOP_ENV];
  });

  afterEach(() => {
    setAgentProcessRegistryHome(null);
    if (previousDetachEnv === undefined) {
      delete process.env[DETACH_AGENTS_ON_STOP_ENV];
    } else {
      process.env[DETACH_AGENTS_ON_STOP_ENV] = previousDetachEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("only an explicit daemon-stop reason on a registered pid may detach", () => {
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
    process.env[DETACH_AGENTS_ON_STOP_ENV] = "1";

    expect(shouldDetachAgentProcess(4242, DAEMON_STOP_CLOSE_REASON)).toBe(true);

    // A user close, and a close that forgot to declare its reason, both
    // terminate — this is the leak the ambient-global version had.
    expect(shouldDetachAgentProcess(4242, "user")).toBe(false);
    expect(shouldDetachAgentProcess(4242, undefined)).toBe(false);

    // Registered for someone else / never recorded: terminate as usual.
    expect(shouldDetachAgentProcess(4243, DAEMON_STOP_CLOSE_REASON)).toBe(false);
    expect(shouldDetachAgentProcess(null, DAEMON_STOP_CLOSE_REASON)).toBe(false);
    expect(shouldDetachAgentProcess(undefined, DAEMON_STOP_CLOSE_REASON)).toBe(false);
    expect(shouldDetachAgentProcess(-1, DAEMON_STOP_CLOSE_REASON)).toBe(false);
  });

  test("a daemon-stop reason without the env opt-in still terminates", () => {
    recordAgentProcess(
      {
        scopeId: "paseo-agent-unit-2",
        unit: "paseo-agent-unit-2.scope",
        pid: 4343,
        provider: "opencode",
        startedAt: new Date().toISOString(),
      },
      { logger },
    );

    // Env unset: default behaviour, even on the daemon-stop path.
    expect(shouldDetachAgentProcess(4343, DAEMON_STOP_CLOSE_REASON)).toBe(false);
  });
});

describe("detach stop vs normal stop with a real child", () => {
  let tmpDir: string;
  let previousDetachEnv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-detach-stop-"));
    setAgentProcessRegistryHome(tmpDir);
    previousDetachEnv = process.env[DETACH_AGENTS_ON_STOP_ENV];
    delete process.env[DETACH_AGENTS_ON_STOP_ENV];
  });

  afterEach(() => {
    setAgentProcessRegistryHome(null);
    if (previousDetachEnv === undefined) {
      delete process.env[DETACH_AGENTS_ON_STOP_ENV];
    } else {
      process.env[DETACH_AGENTS_ON_STOP_ENV] = previousDetachEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("detach-stop skips provider cancel/closeSession/terminate and the scoped child survives", async () => {
    process.env[DETACH_AGENTS_ON_STOP_ENV] = "1";

    const child = spawnRealChild();
    const pid = registerChild(child);
    const session = createSession();
    const internals = attachChild(session, child);
    // close() nulls internals.connection on its way out; assert on our reference.
    const connection = internals.connection as NonNullable<DetachACPInternals["connection"]>;

    try {
      await expect(session.close({ reason: DAEMON_STOP_CLOSE_REASON })).resolves.toEqual({
        detached: true,
      });

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
    const child = spawnRealChild();
    const pid = registerChild(child);
    const session = createSession();
    const internals = attachChild(session, child);
    const connection = internals.connection as NonNullable<DetachACPInternals["connection"]>;

    await session.close({ reason: "user" });

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
    process.env[DETACH_AGENTS_ON_STOP_ENV] = "1";

    // Never recorded: unscoped children cannot be adopted, so they keep
    // today's teardown even on an explicit daemon-stop close.
    const child = spawnRealChild();
    const session = createSession();
    const internals = attachChild(session, child);
    const connection = internals.connection as NonNullable<DetachACPInternals["connection"]>;

    await session.close({ reason: DAEMON_STOP_CLOSE_REASON });

    expect(connection.cancel).toHaveBeenCalled();
    expect(connection.unstable_closeSession).toHaveBeenCalled();
    expect(child.exitCode === null && child.signalCode === null).toBe(false);
  });

  /**
   * B2 regression guard. Under the old process-global `detachStopActive` flag,
   * this close detached the child because the flag happened to be set by a
   * daemon stop that was in progress. Detach is now carried on the call, so an
   * owner-initiated close always terminates its child.
   */
  test("a USER close terminates a registered scoped child even while a stop is configured", async () => {
    process.env[DETACH_AGENTS_ON_STOP_ENV] = "1";

    const child = spawnRealChild();
    const pid = registerChild(child);
    const session = createSession();
    const internals = attachChild(session, child);
    const connection = internals.connection as NonNullable<DetachACPInternals["connection"]>;

    try {
      await expect(session.close({ reason: "user" })).resolves.toEqual({ detached: false });

      expect(connection.cancel).toHaveBeenCalled();
      expect(connection.unstable_closeSession).toHaveBeenCalled();
      expect(child.exitCode === null && child.signalCode === null).toBe(false);
      expect(isPidAlive(pid)).toBe(false);
    } finally {
      await killAndWait(child);
    }
  });

  test("a close with NO reason terminates a registered scoped child", async () => {
    process.env[DETACH_AGENTS_ON_STOP_ENV] = "1";

    const child = spawnRealChild();
    const pid = registerChild(child);
    const session = createSession();
    const internals = attachChild(session, child);
    const connection = internals.connection as NonNullable<DetachACPInternals["connection"]>;

    try {
      await expect(session.close()).resolves.toEqual({ detached: false });

      expect(connection.cancel).toHaveBeenCalled();
      expect(connection.unstable_closeSession).toHaveBeenCalled();
      expect(isPidAlive(pid)).toBe(false);
    } finally {
      await killAndWait(child);
    }
  });
});
