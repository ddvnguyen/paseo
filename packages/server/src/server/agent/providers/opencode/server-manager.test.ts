import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { spawnProcess } from "../../../../utils/spawn.js";
import { __resetAgentDetachForTests, beginAgentDetachStop } from "../../agent-detach.js";
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
    __resetAgentDetachForTests();
    spawnedChildren = [];
    eventSourceFactory = createFakeEventSourceFactory();
  });

  afterEach(async () => {
    for (const child of spawnedChildren) {
      await killAndWait(child);
    }
    spawnedChildren = [];
    __resetAgentDetachForTests();
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

    await manager.shutdown();

    expect(hasExited(serverChild)).toBe(true);
    expect(isPidAlive(requirePid(serverChild))).toBe(false);
    expect(eventSourceFactory.closeCount()).toBe(1);
  });

  test("shutdown leaves a registry-recorded server running during a detach stop", async () => {
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    expect(beginAgentDetachStop(logger)).toBe(true);
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
      await manager.shutdown();

      expect(eventSourceFactory.closeCount()).toBe(1);
      expect(isPidAlive(pid)).toBe(true);
      expect(hasExited(serverChild)).toBe(false);
    } finally {
      await killAndWait(serverChild);
    }
  });

  test("shutdown terminates the server when detach is engaged but the pid is unregistered", async () => {
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    expect(beginAgentDetachStop(logger)).toBe(true);
    const { manager, child } = createManager();

    await manager.acquireCurrent();
    const serverChild = child();

    await manager.shutdown();

    expect(hasExited(serverChild)).toBe(true);
    expect(isPidAlive(requirePid(serverChild))).toBe(false);
  });
});
