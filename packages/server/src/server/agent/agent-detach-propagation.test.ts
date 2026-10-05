import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { spawnProcess } from "../../utils/spawn.js";
import { DAEMON_STOP_CLOSE_REASON } from "./agent-detach.js";
import {
  isPidAlive,
  recordAgentProcess,
  setAgentProcessRegistryHome,
} from "./agent-process-registry.js";
import { AgentStorage } from "./agent-storage.js";
import { AgentManager } from "./agent-manager.js";
import { wrapSessionProvider } from "./provider-registry.js";
import { __openCodeInternals } from "./providers/opencode-agent.js";
import {
  OpenCodeServerManager,
  type OpenCodeServerProcessSpawner,
} from "./providers/opencode/server-manager.js";
import type {
  OpenCodeEventConsumer,
  OpenCodeEventConsumerFactory,
} from "./providers/opencode/event-consumer.js";
import type { AgentCapabilityFlags, AgentClient, AgentSession } from "./agent-sdk-types.js";

/**
 * End-to-end proof that a daemon-stop close reason survives the WHOLE chain:
 *
 *   AgentManager.closeAgent(id, { reason: "daemon-stop" })
 *     -> closeAgentRuntime -> agent.session.close({ reason })
 *       -> wrapSessionProvider.close(options)          [provider-registry hop]
 *         -> OpenCodeAgentSession.close(options)
 *           -> this.releaseServer?.(options)           [opencode hop]
 *             -> acquisition.release(options)
 *               -> OpenCodeServerManager.releaseServer(generation, reason)
 *                 -> killServer(generation, reason)     [the gate]
 *
 * Both intermediate hops are pure pass-throughs, which is exactly why they are
 * dangerous: dropping the argument in either one fails SILENTLY. Nothing throws,
 * no log line looks wrong, and every other suite stays green, because the
 * observable effect is only "detach-on-stop quietly never happens".
 *
 * The reason is set in exactly one place in production — `bootstrap.ts`'s
 * `closeAllAgents` fan-out, `reason: detach ? "daemon-stop" : "user"` — and
 * `bootstrap.stop()` is not unit-testable in isolation, so this test enters the
 * chain at the first reachable point instead: the same `closeAgent(agentId, {
 * reason: "daemon-stop" })` call the daemon stop path makes.
 *
 * Everything below the manager is REAL except the OpenCode HTTP client (the
 * detach path skips `abort`/`session.delete` entirely, and a real server would
 * make this test depend on an installed opencode binary). The server process is
 * a REAL spawned child, the registry entry is REAL on disk, and the assertions
 * are on the server's actual liveness plus the PERSISTED agent record — the two
 * things the detach contract is about.
 */
const logger = createTestLogger();

const TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

describe("daemon-stop reason propagation, end to end", () => {
  let tmpDir: string;
  let previousDetachEnv: string | undefined;
  let spawnedChildren: ChildProcess[];
  let eventSourceCloses: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "paseo-detach-e2e-"));
    setAgentProcessRegistryHome(path.join(tmpDir, "registry-home"));
    previousDetachEnv = process.env.PASEO_DETACH_AGENTS_ON_STOP;
    delete process.env.PASEO_DETACH_AGENTS_ON_STOP;
    spawnedChildren = [];
    eventSourceCloses = 0;
  });

  afterEach(async () => {
    for (const child of spawnedChildren) {
      if (child.exitCode !== null || child.signalCode !== null) {
        continue;
      }
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    setAgentProcessRegistryHome(null);
    if (previousDetachEnv === undefined) {
      delete process.env.PASEO_DETACH_AGENTS_ON_STOP;
    } else {
      process.env.PASEO_DETACH_AGENTS_ON_STOP = previousDetachEnv;
    }
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function hasExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  function requirePid(child: ChildProcess): number {
    const pid = child.pid;
    if (typeof pid !== "number") {
      throw new Error("spawned OpenCode server child has no pid");
    }
    return pid;
  }

  /**
   * A real `OpenCodeServerManager` over a real spawned child. The child is a
   * long-lived node process standing in for `opencode serve`.
   */
  function createServerManager(): {
    manager: OpenCodeServerManager;
    child: () => ChildProcess;
  } {
    let spawnedChild: ChildProcess | null = null;
    const createEventSource: OpenCodeEventConsumerFactory = () => {
      const source = {
        ready: async (): Promise<void> => undefined,
        subscribe: () => () => undefined,
        close: async (): Promise<void> => {
          eventSourceCloses += 1;
        },
      };
      return source as unknown as OpenCodeEventConsumer;
    };
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
        portAllocator: async () => 41779,
        createEventSource,
      }),
      child: () => {
        if (!spawnedChild) {
          throw new Error("OpenCode server child was never spawned");
        }
        return spawnedChild;
      },
    };
  }

  /**
   * Build the full stack: AgentManager -> real `wrapSessionProvider` -> real
   * `OpenCodeAgentSession` -> real `OpenCodeServerManager` acquisition.
   *
   * `wrapSessionProvider` is the real exported function, used under the aliased
   * provider id `opencode-work`. That is exactly how production reaches it:
   * `createResolvedProviderClient` takes the wrapping branch whenever the inner
   * client's provider id differs from the registered one (a `providerOverrides`
   * entry with its own id) or model overrides are configured — and it does NOT
   * wrap a plain, un-overridden `opencode`.
   */
  async function createStack(options: { provider: string; agentId: string }): Promise<{
    manager: AgentManager;
    storage: AgentStorage;
    serverChild: ChildProcess;
    serverPid: number;
    cwd: string;
  }> {
    const cwd = path.join(tmpDir, "workspace");
    mkdirSync(cwd, { recursive: true });
    const storage = new AgentStorage(path.join(tmpDir, "agents"), logger);
    const { manager: serverManager, child } = createServerManager();

    const acquisition = await serverManager.acquireCurrent();
    const serverChild = child();
    const serverPid = requirePid(serverChild);

    const sessionApi = {
      abort: vi.fn().mockResolvedValue({ error: null }),
      update: vi.fn().mockResolvedValue({ error: null }),
      delete: vi.fn().mockResolvedValue({ error: null }),
    };
    const providerSession = new __openCodeInternals.OpenCodeAgentSession(
      { provider: "opencode-work", cwd, providerOptions: {} },
      { session: sessionApi } as never,
      "ses_detach_e2e",
      logger,
      new Map(),
      undefined, // events
      (closeOptions) => acquisition.release(closeOptions),
      true, // persistSession
      options.agentId,
      serverPid,
    );

    // The registry wrapper is in the path, verbatim.
    const wrapped: AgentSession = wrapSessionProvider(options.provider, providerSession);

    const client = {
      provider: options.provider,
      capabilities: TEST_CAPABILITIES,
      isAvailable: async () => true,
      createSession: async () => wrapped,
    } as unknown as AgentClient;

    const manager = new AgentManager({
      clients: { [options.provider]: client },
      registry: storage,
      logger,
      idFactory: () => options.agentId,
    });

    return { manager, storage, serverChild, serverPid, cwd };
  }

  function recordServerPid(pid: number): void {
    expect(
      recordAgentProcess(
        {
          scopeId: "paseo-detach-e2e",
          unit: "paseo-detach-e2e.scope",
          pid,
          provider: "opencode",
          startedAt: new Date().toISOString(),
        },
        { logger },
      ),
    ).toBe(true);
  }

  test("a daemon-stop closeAgent leaves the scoped server ALIVE and the snapshot non-resumable", async () => {
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    const agentId = "00000000-0000-4000-8000-000000000301";
    const { manager, storage, serverChild, serverPid, cwd } = await createStack({
      provider: "opencode-work",
      agentId,
    });
    recordServerPid(serverPid);

    try {
      await manager.createAgent({ provider: "opencode-work", cwd }, undefined, {
        workspaceId: undefined,
      });
      await storage.flush();
      // Precondition: while live, the persisted record IS resumable.
      expect((await storage.get(agentId))?.persistence?.sessionId).toBe("ses_detach_e2e");

      // This is the exact call `bootstrap.ts`'s closeAllAgents fan-out makes.
      await manager.closeAgent(agentId, { reason: DAEMON_STOP_CLOSE_REASON });
      await storage.flush();

      // Two independent facts, and they must agree:
      //  1. the server process is still running, i.e. the reason reached the
      //     wrapper hop AND the releaseServer hop AND the killServer gate;
      //  2. the snapshot advertises no resumable handle, i.e. the same close
      //     reported `detached` back up to the manager.
      expect(hasExited(serverChild)).toBe(false);
      expect(isPidAlive(serverPid)).toBe(true);
      expect(eventSourceCloses).toBe(1);

      const stored = await storage.get(agentId);
      expect(stored?.persistence).toBeNull();
      expect(stored?.lastStatus).toBe("closed");
    } finally {
      await storage.flush();
    }
  });

  test("the same chain with reason:user terminates the server and keeps the snapshot resumable", async () => {
    // Negative control. If this passed with `detached: true`, the gate itself
    // would be broken rather than the propagation; it pins both directions.
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    const agentId = "00000000-0000-4000-8000-000000000302";
    const { manager, storage, serverChild, serverPid, cwd } = await createStack({
      provider: "opencode-work",
      agentId,
    });
    recordServerPid(serverPid);

    try {
      await manager.createAgent({ provider: "opencode-work", cwd }, undefined, {
        workspaceId: undefined,
      });
      await storage.flush();
      expect((await storage.get(agentId))?.persistence?.sessionId).toBe("ses_detach_e2e");

      await manager.closeAgent(agentId, { reason: "user" });
      await storage.flush();

      expect(hasExited(serverChild)).toBe(true);
      expect(isPidAlive(serverPid)).toBe(false);
      expect((await storage.get(agentId))?.persistence?.sessionId).toBe("ses_detach_e2e");
    } finally {
      await storage.flush();
    }
  });

  test("an UNREGISTERED server is terminated even on a daemon-stop close", async () => {
    // Detach is opt-in per child: a plain-spawned server cannot outlive the
    // daemon's cgroup, so leaving it running would create an unadoptable
    // orphan. Both the session's `detached` report and the kill gate must agree
    // that it does not survive, so the snapshot stays resumable.
    process.env.PASEO_DETACH_AGENTS_ON_STOP = "1";
    const agentId = "00000000-0000-4000-8000-000000000303";
    const { manager, storage, serverChild, serverPid, cwd } = await createStack({
      provider: "opencode-work",
      agentId,
    });

    try {
      await manager.createAgent({ provider: "opencode-work", cwd }, undefined, {
        workspaceId: undefined,
      });
      await storage.flush();

      await manager.closeAgent(agentId, { reason: DAEMON_STOP_CLOSE_REASON });
      await storage.flush();

      expect(hasExited(serverChild)).toBe(true);
      expect(isPidAlive(serverPid)).toBe(false);
      expect((await storage.get(agentId))?.persistence?.sessionId).toBe("ses_detach_e2e");
    } finally {
      await storage.flush();
    }
  });
});
