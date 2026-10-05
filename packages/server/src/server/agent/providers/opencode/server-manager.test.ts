import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { spawnProcess } from "../../../../utils/spawn.js";
import { DAEMON_STOP_CLOSE_REASON } from "../../agent-detach.js";
import {
  isPidAlive,
  recordAgentProcess,
  setAgentProcessRegistryHome,
} from "../../agent-process-registry.js";
import type {
  OpenCodeEventConsumer,
  OpenCodeEventConsumerFactory,
  OpenCodeEventSourceInput,
} from "./event-consumer.js";
import { OpenCodeServerManager, type OpenCodeServerProcessSpawner } from "./server-manager.js";
import type { AgentCloseOptions } from "../../agent-sdk-types.js";
import { __openCodeInternals } from "../opencode-agent.js";

const logger = createTestLogger();

interface FakeEventSourceFactory {
  createEventSource: OpenCodeEventConsumerFactory;
  closeCount: () => number;
}

function createFakeEventSourceFactory(): FakeEventSourceFactory {
  let closes = 0;
  const source = {
    ready: async (): Promise<void> => undefined,
    subscribe:
      (_listener: (input: OpenCodeEventSourceInput) => void): (() => void) =>
      () =>
        undefined,
    close: async (): Promise<void> => {
      closes += 1;
    },
  };
  // OpenCodeEventConsumer is nominally typed (private fields), so a structural
  // fake can only reach the factory through a cast.
  const createEventSource: OpenCodeEventConsumerFactory = () =>
    source as unknown as OpenCodeEventConsumer;
  return { createEventSource, closeCount: () => closes };
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function requirePid(child: ChildProcess): number {
  const pid = child.pid;
  if (typeof pid !== "number") {
    throw new Error("Spawned OpenCode server child has no pid");
  }
  return pid;
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (hasExited(child)) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

describe("OpenCodeServerManager detach-stop shutdown gate", () => {
  let tmpDir: string;
  let previousDetachEnv: string | undefined;
  let spawnedChildren: ChildProcess[];
  let eventSourceFactory: FakeEventSourceFactory;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "opencode-server-detach-"));
    setAgentProcessRegistryHome(path.join(tmpDir, "registry-home"));
    previousDetachEnv = process.env.PASEO_DETACH_AGENTS_ON_STOP;
    delete process.env.PASEO_DETACH_AGENTS_ON_STOP;
    spawnedChildren = [];
    eventSourceFactory = createFakeEventSourceFactory();
  });

  afterEach(async () => {
    for (const child of spawnedChildren) {
      await killAndWait(child);
    }
    spawnedChildren = [];
    setAgentProcessRegistryHome(null);
    if (previousDetachEnv === undefined) {
      delete process.env.PASEO_DETACH_AGENTS_ON_STOP;
    } else {
      process.env.PASEO_DETACH_AGENTS_ON_STOP = previousDetachEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createManager(): { manager: OpenCodeServerManager; child: () => ChildProcess } {
    let spawnedChild: ChildProcess | null = null;
    const spawnServerProcess: OpenCodeServerProcessSpawner = (command, args, options) => {
      const child = spawnProcess(command, args, options);
      spawnedChild = child;
      spawnedChildren.push(child);
      return child;
    };
    return {
      manager: new OpenCodeServerManager({
        logger,
        spawnServerProcess,
        resolveCommandPrefix: async () => ({
          command: process.execPath,
          args: ["-e", 'console.log("listening on"); setInterval(() => {}, 1000)'],
        }),
        resolveHomeDir: () => path.join(tmpDir, "opencode-home"),
        portAllocator: async () => 41777,
        createEventSource: eventSourceFactory.createEventSource,
      }),
      child: () => {
        if (!spawnedChild) {
          throw new Error("OpenCode server child was never spawned");
        }
        return spawnedChild;
      },
    };
  }

  test("shutdown terminates the spawned server when detach is not engaged", async () => {
    const { manager, child } = createManager();

    await manager.acquireCurrent();
    const serverChild = child();

    // No reason: an ordinary shutdown must terminate exactly as before.
    await manager.shutdown();

    expect(hasExited(serverChild)).toBe(true);
    expect(isPidAlive(requirePid(serverChild))).toBe(false);
    expect(eventSourceFactory.closeCount()).toBe(1);
  });

  test("shutdown terminates a registry-recorded server when the caller is a user close", async () => {
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    const { manager, child } = createManager();

    await manager.acquireCurrent();
    const serverChild = child();
    const pid = requirePid(serverChild);
    expect(
      recordAgentProcess(
        {
          scopeId: "paseo-agent-test",
          unit: "paseo-agent-test.scope",
          pid,
          provider: "opencode",
          startedAt: new Date().toISOString(),
        },
        { logger },
      ),
    ).toBe(true);

    // Detach is configured AND the pid is registered, but this close is not a
    // daemon stop. The gate is call-scoped, so the server must still die.
    await manager.shutdown({ reason: "user" });

    expect(isPidAlive(pid)).toBe(false);
    expect(hasExited(serverChild)).toBe(true);
  });

  test("shutdown leaves a registry-recorded server running during a detach stop", async () => {
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    const { manager, child } = createManager();

    await manager.acquireCurrent();
    const serverChild = child();
    const pid = requirePid(serverChild);
    expect(
      recordAgentProcess(
        {
          scopeId: "paseo-agent-test",
          unit: "paseo-agent-test.scope",
          pid,
          provider: "opencode",
          startedAt: new Date().toISOString(),
        },
        { logger },
      ),
    ).toBe(true);

    try {
      await manager.shutdown({ reason: DAEMON_STOP_CLOSE_REASON });

      expect(eventSourceFactory.closeCount()).toBe(1);
      expect(isPidAlive(pid)).toBe(true);
      expect(hasExited(serverChild)).toBe(false);
    } finally {
      await killAndWait(serverChild);
    }
  });

  test("shutdown terminates the server when detach is configured but the pid is unregistered", async () => {
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    const { manager, child } = createManager();

    await manager.acquireCurrent();
    const serverChild = child();

    await manager.shutdown({ reason: DAEMON_STOP_CLOSE_REASON });

    expect(hasExited(serverChild)).toBe(true);
    expect(isPidAlive(requirePid(serverChild))).toBe(false);
  });
});

/**
 * The session -> server-manager hand-off hop.
 *
 * `OpenCodeAgentSession.close` decides `detached` from the per-pid gate and
 * reports it to `AgentManager`, but it does NOT decide the server process's
 * fate: that is `this.releaseServer?.(options)` -> `acquireServer(...).release`
 * -> `OpenCodeServerManager.releaseServer` -> `killServer`, and only
 * `killServer` applies the same gate to the same `reason`.
 *
 * Those two decisions must agree. If the session forwards no reason, the server
 * is KILLED while the session still reports `detached: true` — the agent is
 * dead, yet `AgentManager` writes `persistence: null` for it, so it is also
 * unresumable. That is the worst possible outcome and it is completely silent.
 *
 * So these tests use the REAL manager, a REAL spawned child, and the REAL
 * acquisition `release`; only the OpenCode HTTP client is stubbed (the session
 * skips `abort`/`session.delete` entirely on the detach path).
 */
describe("OpenCodeAgentSession release hand-off carries the close reason", () => {
  let tmpDir: string;
  let previousDetachEnv: string | undefined;
  let spawnedChildren: ChildProcess[];
  let eventSourceFactory: FakeEventSourceFactory;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "opencode-handoff-"));
    setAgentProcessRegistryHome(path.join(tmpDir, "registry-home"));
    previousDetachEnv = process.env.PASEO_DETACH_AGENTS_ON_STOP;
    delete process.env.PASEO_DETACH_AGENTS_ON_STOP;
    spawnedChildren = [];
    eventSourceFactory = createFakeEventSourceFactory();
  });

  afterEach(async () => {
    for (const child of spawnedChildren) {
      await killAndWait(child);
    }
    spawnedChildren = [];
    setAgentProcessRegistryHome(null);
    if (previousDetachEnv === undefined) {
      delete process.env.PASEO_DETACH_AGENTS_ON_STOP;
    } else {
      process.env.PASEO_DETACH_AGENTS_ON_STOP = previousDetachEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createManager(): { manager: OpenCodeServerManager; child: () => ChildProcess } {
    let spawnedChild: ChildProcess | null = null;
    const spawnServerProcess: OpenCodeServerProcessSpawner = (command, args, options) => {
      const child = spawnProcess(command, args, options);
      spawnedChild = child;
      spawnedChildren.push(child);
      return child;
    };
    return {
      manager: new OpenCodeServerManager({
        logger,
        spawnServerProcess,
        resolveCommandPrefix: async () => ({
          command: process.execPath,
          args: ["-e", 'console.log("listening on"); setInterval(() => {}, 1000)'],
        }),
        resolveHomeDir: () => path.join(tmpDir, "opencode-home"),
        portAllocator: async () => 41778,
        createEventSource: eventSourceFactory.createEventSource,
      }),
      child: () => {
        if (!spawnedChild) {
          throw new Error("OpenCode server child was never spawned");
        }
        return spawnedChild;
      },
    };
  }

  function recordServerPid(pid: number): void {
    expect(
      recordAgentProcess(
        {
          scopeId: "paseo-agent-handoff-test",
          unit: "paseo-agent-handoff-test.scope",
          pid,
          provider: "opencode",
          startedAt: new Date().toISOString(),
        },
        { logger },
      ),
    ).toBe(true);
  }

  /**
   * A real `OpenCodeAgentSession` wired to a REAL `OpenCodeServerManager`
   * acquisition. `releaseServer` is `acquisition.release` verbatim, so
   * `session.close(options)` exercises the whole hand-off.
   *
   * The session holds the acquisition's ONLY reference (one `acquireCurrent`,
   * released by the session's own close), so that close is the one which takes
   * the refcount to zero and actually reaches `killServer`.
   */
  async function createSessionOverRealServer(options: { manager: OpenCodeServerManager }): Promise<{
    session: InstanceType<typeof __openCodeInternals.OpenCodeAgentSession>;
    sessionApi: { abort: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
    serverPid: number;
  }> {
    const sessionApi = {
      abort: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockResolvedValue({ error: null }),
      delete: vi.fn().mockResolvedValue({ error: null }),
    };
    const acquisition = await options.manager.acquireCurrent();
    const serverChild = spawnedChildren[spawnedChildren.length - 1];
    if (!serverChild) {
      throw new Error("expected the OpenCode server manager to have spawned a child");
    }
    const serverPid = requirePid(serverChild);
    const session = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode", cwd: tmpDir, providerOptions: {} },
      { session: sessionApi } as never,
      "ses_handoff",
      logger,
      new Map(),
      undefined, // events
      (closeOptions?: AgentCloseOptions) => acquisition.release(closeOptions),
      false, // persistSession
      undefined, // agentId
      serverPid,
    );
    return { session, sessionApi, serverPid };
  }

  test("a daemon-stop close leaves the scoped server RUNNING through the real hand-off", async () => {
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    const { manager, child } = createManager();
    const { session, serverPid } = await createSessionOverRealServer({ manager });
    const serverChild = child();
    recordServerPid(serverPid);

    try {
      await expect(session.close({ reason: DAEMON_STOP_CLOSE_REASON })).resolves.toEqual({
        detached: true,
      });
      // The session reports that its writer survived. That claim is only true
      // if the reason also survived the hand-off and `killServer` honoured it.
      expect(isPidAlive(serverPid)).toBe(true);
      expect(hasExited(serverChild)).toBe(false);
    } finally {
      await killAndWait(serverChild);
    }
  });

  test("a USER close through the real hand-off still kills the scoped server", async () => {
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    const { manager, child } = createManager();
    const { session, sessionApi, serverPid } = await createSessionOverRealServer({ manager });
    const serverChild = child();
    recordServerPid(serverPid);

    await session.close({ reason: "user" });

    expect(isPidAlive(serverPid)).toBe(false);
    expect(hasExited(serverChild)).toBe(true);
    // The non-detached path also tears the provider session down, unlike the
    // detach path which must leave it for the next daemon.
    expect(sessionApi.abort).toHaveBeenCalled();
    expect(sessionApi.delete).toHaveBeenCalled();
  });

  test("a daemon-stop close on an UNREGISTERED server kills it, so detached:false is truthful", async () => {
    // The `detached` return value is computed from the same registry the kill
    // gate uses. If the two ever disagreed, `detached: false` next to a killed
    // server is the safe direction and `detached: true` next to a killed
    // server is the dangerous one, so cover the unregistered shape too.
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    const { manager, child } = createManager();
    const { session, serverPid } = await createSessionOverRealServer({ manager });
    const serverChild = child();

    await expect(session.close({ reason: DAEMON_STOP_CLOSE_REASON })).resolves.toEqual({
      detached: false,
    });
    expect(isPidAlive(serverPid)).toBe(false);
    expect(hasExited(serverChild)).toBe(true);
  });

  test("a reasonless LAST release does not kill a server a daemon-stop release already detached", async () => {
    // The kill decision belongs to whichever holder drops the refcount to
    // zero, and that holder is often an unrelated draft/probe close with no
    // reason. Before the fix, that close killed a server the daemon-stop
    // holder had already been told was surviving — so the daemon-stopping
    // agent lost both its writer AND its resumable snapshot.
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    const { manager, child } = createManager();
    // Three concurrent holders of ONE generation, like a batch of agents
    // sharing an opencode server while the daemon stops.
    const firstHolder = await manager.acquireCurrent();
    const detachingHolder = await manager.acquireCurrent();
    const lastHolder = await manager.acquireCurrent();
    const serverChild = child();
    const serverPid = requirePid(serverChild);
    recordServerPid(serverPid);

    try {
      // The daemon-stop holder goes first, leaving the refcount above zero.
      await detachingHolder.release({ reason: DAEMON_STOP_CLOSE_REASON });
      expect(isPidAlive(serverPid)).toBe(true);

      await firstHolder.release();

      // The holder that takes the refcount to zero is a REASONLESS close. It
      // must not kill a server another holder already detached.
      await lastHolder.release();
      expect(isPidAlive(serverPid)).toBe(true);
      expect(hasExited(serverChild)).toBe(false);
    } finally {
      await killAndWait(serverChild);
    }
  });

  test("when NO holder detached, the last release still kills the server", async () => {
    // Negative control for the test above: the any-detached-holder rule must
    // not turn ordinary refcount teardown into a permanent server leak.
    const { manager, child } = createManager();
    const firstHolder = await manager.acquireCurrent();
    const lastHolder = await manager.acquireCurrent();
    const serverChild = child();
    const serverPid = requirePid(serverChild);

    await firstHolder.release({ reason: "user" });
    await lastHolder.release();

    expect(isPidAlive(serverPid)).toBe(false);
    expect(hasExited(serverChild)).toBe(true);
  });

  test("a daemon-stop release does not detach a kill when detach is not configured", async () => {
    // The `sawDetachedHolder` flag must be gated exactly like the kill it
    // suppresses: with the opt-in off there is nothing to detach from, so a
    // daemon-stop release is an ordinary close and the server must still die.
    const { manager, child } = createManager();
    const firstHolder = await manager.acquireCurrent();
    const lastHolder = await manager.acquireCurrent();
    const serverChild = child();
    const serverPid = requirePid(serverChild);

    await firstHolder.release({ reason: DAEMON_STOP_CLOSE_REASON });
    await lastHolder.release({ reason: "user" });

    expect(isPidAlive(serverPid)).toBe(false);
  });

  test("an UNREGISTERED pid still dies even when a daemon-stop holder released first", async () => {
    // The flag is set by the same per-pid gate the kill uses, so an
    // unregistered generation is never marked detached and cannot leak.
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    const { manager, child } = createManager();
    const firstHolder = await manager.acquireCurrent();
    const lastHolder = await manager.acquireCurrent();
    const serverChild = child();
    const serverPid = requirePid(serverChild);
    // Deliberately NOT recorded in the scope registry.

    await firstHolder.release({ reason: DAEMON_STOP_CLOSE_REASON });
    await lastHolder.release();

    expect(isPidAlive(serverPid)).toBe(false);
    expect(hasExited(serverChild)).toBe(true);
  });
});
