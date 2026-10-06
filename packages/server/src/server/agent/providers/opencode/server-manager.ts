import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import type { Logger } from "pino";

import { findExecutable } from "../../../../executable-resolution/executable-resolution.js";
import type { SpawnProcessOptions } from "../../../../utils/spawn.js";
import { spawnInAgentScope } from "../../agent-process-scope.js";
import { DAEMON_STOP_CLOSE_REASON, shouldDetachAgentProcess } from "../../agent-detach.js";
import type { AgentCloseOptions, AgentCloseReason } from "../../agent-sdk-types.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../../../utils/tree-kill.js";
import type { ManagedProcessRegistry } from "../../../managed-processes/managed-processes.js";
import {
  createProviderEnv,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import { resolveOpenCodeHomeDir } from "./paths.js";
import {
  OpenCodeEventConsumer,
  type OpenCodeEventConsumerFactory,
  type OpenCodeEventSource,
} from "./event-consumer.js";

/** Budget for the OpenCode HTTP server to become usable after spawn. */
export const OPENCODE_SERVER_STARTUP_TIMEOUT_MS = 30_000;
/** One stalled SSE attempt plus enough time for the consumer's retry. */
export const OPENCODE_EVENT_STREAM_READY_TIMEOUT_MS = 45_000;
const OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;

export interface OpenCodeServerAcquisition {
  environment: Record<string, string>;
  server: { port: number; url: string; pid?: number };
  events: OpenCodeEventSource;
  release: (options?: AgentCloseOptions) => Promise<void>;
}

export interface OpenCodeServerManagerLike {
  acquireCurrent(signal?: AbortSignal): Promise<OpenCodeServerAcquisition>;
  acquireNew(signal?: AbortSignal): Promise<OpenCodeServerAcquisition>;
  acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition>;
  acquireExisting(url: string): OpenCodeServerAcquisition | null;
  shutdown(options?: OpenCodeServerShutdownOptions): Promise<void>;
}

/**
 * `reason` rides along to killServer exactly like AgentSession.close's does, so
 * detach stays a property of the call rather than of the process.
 */
export interface OpenCodeServerShutdownOptions {
  reason?: AgentCloseReason;
}

export interface OpenCodeServerGeneration {
  environment: Record<string, string>;
  process: ChildProcess;
  port: number;
  url: string;
  refCount: number;
  retired: boolean;
  ready: Promise<void>;
  events: OpenCodeEventConsumer;
  managedProcessId?: string;
  managedProcessRecord?: Promise<{ id: string } | null>;
  /**
   * Set once any holder's release was a detach-eligible daemon stop, i.e. some
   * session was told (`detached: true`) that this generation is outliving it.
   *
   * The kill decision is made by whichever holder happens to drop `refCount`
   * to zero, and that holder is often an unrelated draft/probe close carrying
   * no reason. Pure last-releaser-wins would then kill a server a daemon-stop
   * close already reported as surviving — so the agents that close left with
   * neither a writer nor a resumable snapshot. Any-detached-holder-wins is the
   * safe direction: a leaked server generation is reclaimable on the next
   * daemon via the scope registry, whereas killing one destroys live work.
   */
  sawDetachedHolder: boolean;
}

export type OpenCodePortAllocator = () => Promise<number>;
export type OpenCodeCommandPrefixResolver = () => Promise<{ command: string; args: string[] }>;
export type OpenCodeServerProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnProcessOptions,
) => ChildProcess;

export interface OpenCodeServerManagerOptions {
  logger: Logger;
  baseEnv?: SpawnProcessOptions["baseEnv"];
  runtimeSettings?: ProviderRuntimeSettings;
  managedProcesses?: ManagedProcessRegistry;
  terminateProcess?: ProcessTerminator;
  portAllocator?: OpenCodePortAllocator;
  resolveCommandPrefix?: OpenCodeCommandPrefixResolver;
  resolveHomeDir?: () => string;
  spawnServerProcess?: OpenCodeServerProcessSpawner;
  createEventSource?: OpenCodeEventConsumerFactory;
  decorateServerEnv?: (env: Record<string, string>) => Record<string, string>;
}

export class OpenCodeServerManager implements OpenCodeServerManagerLike {
  private static instance: OpenCodeServerManager | null = null;
  private static exitHandlerRegistered = false;
  private currentServer: OpenCodeServerGeneration | null = null;
  private retiredServers = new Set<OpenCodeServerGeneration>();
  private startPromise: Promise<OpenCodeServerGeneration> | null = null;
  private newServerPromise: Promise<OpenCodeServerGeneration> | null = null;
  private readonly logger: Logger;
  private readonly baseEnv?: SpawnProcessOptions["baseEnv"];
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly runtimeSettingsKey: string;
  private readonly managedProcesses?: ManagedProcessRegistry;
  private readonly terminateProcess: ProcessTerminator;
  private readonly portAllocator: OpenCodePortAllocator;
  private readonly resolveCommandPrefix: OpenCodeCommandPrefixResolver;
  private readonly resolveHomeDir: () => string;
  private readonly spawnServerProcess: OpenCodeServerProcessSpawner;
  private readonly createEventSource: OpenCodeEventConsumerFactory;
  private readonly decorateServerEnv?: (env: Record<string, string>) => Record<string, string>;

  constructor(options: OpenCodeServerManagerOptions) {
    this.logger = options.logger;
    this.baseEnv = options.baseEnv;
    this.runtimeSettings = options.runtimeSettings;
    this.runtimeSettingsKey = JSON.stringify(this.runtimeSettings ?? {});
    this.managedProcesses = options.managedProcesses;
    this.terminateProcess = options.terminateProcess ?? terminateWithTreeKill;
    this.portAllocator = options.portAllocator ?? findAvailablePort;
    this.resolveCommandPrefix =
      options.resolveCommandPrefix ??
      (() => resolveProviderCommandPrefix(this.runtimeSettings?.command, resolveOpenCodeBinary));
    this.resolveHomeDir = options.resolveHomeDir ?? resolveOpenCodeHomeDir;
    this.spawnServerProcess =
      options.spawnServerProcess ??
      ((command, args, spawnOptions) =>
        spawnInAgentScope(command, args, spawnOptions, {
          provider: "opencode",
          logger: this.logger,
        }));
    this.createEventSource =
      options.createEventSource ?? ((input) => new OpenCodeEventConsumer(input));
    this.decorateServerEnv = options.decorateServerEnv;
  }

  static getInstance(
    logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
    options: Omit<OpenCodeServerManagerOptions, "logger" | "runtimeSettings"> = {},
  ): OpenCodeServerManager {
    const nextSettingsKey = JSON.stringify(runtimeSettings ?? {});
    if (!OpenCodeServerManager.instance) {
      OpenCodeServerManager.instance = new OpenCodeServerManager({
        logger,
        runtimeSettings,
        ...options,
      });
      OpenCodeServerManager.registerExitHandler();
    } else if (OpenCodeServerManager.instance.runtimeSettingsKey !== nextSettingsKey) {
      logger.warn(
        {
          existingRuntimeSettings: OpenCodeServerManager.instance.runtimeSettingsKey,
          requestedRuntimeSettings: nextSettingsKey,
        },
        "OpenCode server manager already initialized with different runtime settings",
      );
    }
    return OpenCodeServerManager.instance;
  }

  private static registerExitHandler(): void {
    if (OpenCodeServerManager.exitHandlerRegistered) {
      return;
    }
    OpenCodeServerManager.exitHandlerRegistered = true;

    const cleanup = () => {
      // shutdown() always runs. It used to be skipped entirely when detach was
      // configured, which leaked every server that was NOT in the scope registry
      // (a plain-spawned server after a probe downgrade) — nothing tore them
      // down. Now shutdown runs unconditionally and passes reason:"daemon-stop";
      // killServer applies the per-pid gate, so scoped children survive and
      // unscoped ones get cleaned up. With detach disabled this is today's
      // behaviour exactly.
      const instance = OpenCodeServerManager.instance;
      void instance?.shutdown({ reason: DAEMON_STOP_CLOSE_REASON });
    };

    process.on("exit", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
  }

  async acquireCurrent(signal?: AbortSignal): Promise<OpenCodeServerAcquisition> {
    signal?.throwIfAborted();
    const server = await waitForServerAcquisition(this.getCurrentServer(), signal);
    signal?.throwIfAborted();
    return this.acquireServer(server);
  }

  async acquireNew(signal?: AbortSignal): Promise<OpenCodeServerAcquisition> {
    signal?.throwIfAborted();
    const server = await waitForServerAcquisition(this.getNewServer(), signal);
    signal?.throwIfAborted();
    return this.acquireServer(server);
  }

  async acquireDedicated(env: Record<string, string>): Promise<OpenCodeServerAcquisition> {
    const server = await this.startServer(env);
    server.retired = true;
    this.retiredServers.add(server);
    const acquisition = this.acquireServer(server);
    try {
      await server.ready;
      return acquisition;
    } catch (error) {
      await acquisition.release();
      throw error;
    }
  }

  acquireExisting(url: string): OpenCodeServerAcquisition | null {
    const server = this.findLiveServerByUrl(url);
    return server ? this.acquireServer(server) : null;
  }

  private findLiveServerByUrl(url: string): OpenCodeServerGeneration | null {
    const servers = [
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
    ];
    return servers.find((server) => server.url === url && this.isServerLive(server)) ?? null;
  }

  private isServerLive(server: OpenCodeServerGeneration): boolean {
    return (
      !server.process.killed &&
      server.process.exitCode === null &&
      server.process.signalCode === null
    );
  }

  private acquireServer(server: OpenCodeServerGeneration): OpenCodeServerAcquisition {
    server.refCount += 1;
    let releasePromise: Promise<void> | null = null;
    return {
      server: { port: server.port, url: server.url, pid: server.process.pid },
      events: server.events,
      environment: server.environment,
      release: async (options?: AgentCloseOptions) => {
        if (releasePromise) {
          return releasePromise;
        }
        releasePromise = this.releaseServer(server, options?.reason);
        return releasePromise;
      },
    };
  }

  private async releaseServer(
    server: OpenCodeServerGeneration,
    reason: AgentCloseReason | undefined,
  ): Promise<void> {
    // A detach-eligible release means the holder closing right now is a session
    // that has just been told (`detached: true`) that this generation outlives
    // it. Remember that, because the generation's kill decision is made by
    // whichever holder happens to drop the refcount to zero — and that holder
    // is routinely an unrelated draft/probe close with no reason at all.
    //
    // Last-releaser-wins would then kill a server a daemon-stop close already
    // reported as surviving, and the agents that close would be left with
    // neither a running writer nor a resumable snapshot. Preferring the detach
    // whenever ANY holder detached keeps the two decisions consistent; a
    // surviving server generation stays reclaimable by the next daemon through
    // the scope registry, whereas killing one destroys live work.
    //
    // This is the same gate `killServer` applies, evaluated per release, so an
    // ordinary user close never sets the flag (and never reads the registry
    // file: the gate returns before any I/O unless the reason is a daemon stop
    // and the env opt-in is set).
    if (shouldDetachAgentProcess(server.process.pid, reason)) {
      server.sawDetachedHolder = true;
    }

    server.refCount = Math.max(0, server.refCount - 1);
    if (server.refCount > 0) {
      return;
    }

    if (this.currentServer === server) {
      this.currentServer = null;
      server.retired = true;
    }
    if (!server.retired) {
      return;
    }

    this.retiredServers.delete(server);
    this.logger.info(generationLogContext(server), "OpenCode server generation released");
    await this.killServer(server, server.sawDetachedHolder ? DAEMON_STOP_CLOSE_REASON : reason);
  }

  private async getNewServer(): Promise<OpenCodeServerGeneration> {
    if (this.newServerPromise) {
      return this.newServerPromise;
    }

    this.newServerPromise = Promise.resolve()
      .then(async () => {
        await this.rotateCurrentServer();
        const server = await this.startServer();
        if (!server.retired) {
          this.currentServer = server;
        }
        await server.ready;
        return server;
      })
      .finally(() => {
        this.newServerPromise = null;
      });
    return this.newServerPromise;
  }

  private async getCurrentServer(): Promise<OpenCodeServerGeneration> {
    if (this.newServerPromise) {
      return this.newServerPromise;
    }

    if (this.startPromise) {
      const server = await this.startPromise;
      await server.ready;
      return server;
    }

    if (this.currentServer && !this.currentServer.process.killed) {
      await this.currentServer.ready;
      return this.currentServer;
    }

    this.startPromise = this.startServer().then((server) => {
      if (!server.retired) {
        this.currentServer = server;
      }
      return server;
    });
    const currentStart = this.startPromise;
    const result = await currentStart.finally(() => {
      if (this.startPromise === currentStart) {
        this.startPromise = null;
      }
    });
    await result.ready;
    return result;
  }

  private async rotateCurrentServer(): Promise<void> {
    const existing = this.currentServer;
    if (existing) {
      existing.retired = true;
      this.retiredServers.add(existing);
      this.currentServer = null;
      this.logger.info(generationLogContext(existing), "OpenCode server generation retired");
      await this.cleanupRetiredServers();
    }
    if (this.startPromise) {
      const pending = await this.startPromise;
      pending.retired = true;
      this.retiredServers.add(pending);
      this.currentServer = null;
      this.logger.info(generationLogContext(pending), "OpenCode server generation retired");
      await this.cleanupRetiredServers();
    }
  }

  private async startServer(launchEnv?: Record<string, string>): Promise<OpenCodeServerGeneration> {
    const port = await this.portAllocator();
    const url = `http://127.0.0.1:${port}`;
    const launchPrefix = await this.resolveCommandPrefix();
    const serverArgs = [...launchPrefix.args, "serve", "--port", String(port)];
    // Use a neutral OpenCode home as the server cwd. Launching from the user's
    // home directory causes OpenCode to treat it as the default workspace and
    // index the entire home tree.
    const serverCwd = this.resolveHomeDir();
    mkdirSync(serverCwd, { recursive: true });

    const existingConfigContent =
      launchEnv?.OPENCODE_CONFIG_CONTENT ??
      this.runtimeSettings?.env?.OPENCODE_CONFIG_CONTENT ??
      (typeof this.baseEnv?.OPENCODE_CONFIG_CONTENT === "string"
        ? this.baseEnv.OPENCODE_CONFIG_CONTENT
        : process.env.OPENCODE_CONFIG_CONTENT);
    const bridgeEnv = this.decorateServerEnv?.(
      existingConfigContent ? { OPENCODE_CONFIG_CONTENT: existingConfigContent } : {},
    );
    const environment = createProviderEnv({
      baseEnv: this.baseEnv,
      runtimeSettings: this.runtimeSettings,
      overlays: [launchEnv, bridgeEnv],
    });
    const serverProcess = this.spawnServerProcess(launchPrefix.command, serverArgs, {
      cwd: serverCwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      baseEnv: environment,
    });
    const managedProcessRecord = this.recordManagedServerProcess({
      process: serverProcess,
      command: launchPrefix.command,
      args: serverArgs,
      port,
    });
    let resolveProcessExit!: (error: Error) => void;
    const processExit = new Promise<Error>((resolve) => {
      resolveProcessExit = resolve;
    });
    let resolveListening!: () => void;
    let rejectListening!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveListening = resolve;
      rejectListening = reject;
    });
    const server: OpenCodeServerGeneration = {
      environment,
      process: serverProcess,
      port,
      url,
      refCount: 0,
      retired: false,
      ready: Promise.resolve(),
      events: this.createEventSource({
        serverUrl: url,
        processExit,
        logger: this.logger,
        listening: ready,
      }),
      managedProcessRecord,
      sawDetachedHolder: false,
    };
    this.logger.info(
      { ...generationLogContext(server), dedicated: launchEnv !== undefined },
      "OpenCode server generation started",
    );
    void managedProcessRecord.then((record) => {
      if (record && server.managedProcessRecord === managedProcessRecord) {
        server.managedProcessId = record.id;
      }
      return undefined;
    });

    let started = false;
    let settled = false;
    let stderrBuffer = "";
    let stdoutBuffer = "";
    const STARTUP_BUFFER_CAP = 8192;
    const appendCapped = (current: string, chunk: string): string => {
      if (current.length >= STARTUP_BUFFER_CAP) {
        return current;
      }
      const remaining = STARTUP_BUFFER_CAP - current.length;
      return current + chunk.slice(0, remaining);
    };
    const buildStartupErrorMessage = (headline: string): string => {
      const sections = [headline];
      const stderrTrimmed = stderrBuffer.trim();
      if (stderrTrimmed.length > 0) {
        sections.push(`stderr: ${stderrTrimmed}`);
      }
      const stdoutTrimmed = stdoutBuffer.trim();
      if (stdoutTrimmed.length > 0) {
        sections.push(`stdout: ${stdoutTrimmed}`);
      }
      return sections.join("\n");
    };

    {
      let timeout: ReturnType<typeof setTimeout>;
      const failStartup = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        rejectListening(error);
      };
      timeout = setTimeout(() => {
        if (!started) {
          failStartup(new Error(buildStartupErrorMessage("OpenCode server startup timeout")));
        }
      }, OPENCODE_SERVER_STARTUP_TIMEOUT_MS);

      serverProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        stdoutBuffer = appendCapped(stdoutBuffer, output);
        if (output.includes("listening on") && !settled) {
          started = true;
          settled = true;
          clearTimeout(timeout);
          resolveListening();
        }
      });

      serverProcess.stderr?.on("data", (data: Buffer) => {
        const output = data.toString();
        stderrBuffer = appendCapped(stderrBuffer, output);
        this.logger.error({ stderr: output.trim() }, "OpenCode server stderr");
      });

      serverProcess.on("error", (error) => {
        const headline = error instanceof Error ? error.message : String(error);
        failStartup(new Error(buildStartupErrorMessage(headline)));
      });

      serverProcess.on("exit", (code, signal) => {
        this.logger.info(
          { ...generationLogContext(server), code, signal },
          "OpenCode server generation exited",
        );
        resolveProcessExit(new Error(`OpenCode server exited with code ${code}`));
        this.removeManagedServerRecord(server);
        if (!started) {
          failStartup(
            new Error(buildStartupErrorMessage(`OpenCode server exited with code ${code}`)),
          );
        }
        if (this.currentServer?.process === serverProcess) {
          this.currentServer = null;
        }
        for (const retired of Array.from(this.retiredServers)) {
          if (retired.process === serverProcess) {
            this.retiredServers.delete(retired);
          }
        }
      });
    }

    server.ready = ready.catch(async (error) => {
      // A server that failed to become ready is being abandoned, not preserved:
      // terminate it outright.
      await this.killServer(server, "user");
      if (this.currentServer === server) {
        this.currentServer = null;
      }
      this.retiredServers.delete(server);
      throw error;
    });

    return server;
  }

  async shutdown(options?: OpenCodeServerShutdownOptions): Promise<void> {
    const servers = [
      ...(this.currentServer ? [this.currentServer] : []),
      ...Array.from(this.retiredServers),
    ];
    for (const server of servers) {
      this.logger.info(generationLogContext(server), "OpenCode server generation stopping");
    }
    await Promise.all(servers.map((server) => this.killServer(server, options?.reason)));
    this.currentServer = null;
    this.retiredServers.clear();
  }

  private async cleanupRetiredServers(): Promise<void> {
    const cleanup: Promise<void>[] = [];
    for (const server of Array.from(this.retiredServers)) {
      if (server.refCount === 0) {
        this.retiredServers.delete(server);
        // Refcount-driven retirement is not a daemon stop: these generations are
        // genuinely done, so they are terminated as usual.
        cleanup.push(this.killServer(server, "user"));
      }
    }
    await Promise.all(cleanup);
  }

  private async killServer(
    server: OpenCodeServerGeneration,
    reason: AgentCloseReason | undefined,
  ): Promise<void> {
    await server.events.close();
    if (
      (server.process.exitCode !== null && server.process.exitCode !== undefined) ||
      (server.process.signalCode !== null && server.process.signalCode !== undefined)
    ) {
      return;
    }
    // Detach-stop: a scoped server child stays running for the next daemon.
    // Its managed-process record and scope-registry entry stay too, so the
    // next daemon can reconcile and discover it. The gate is per-pid AND
    // call-scoped on `reason`, so a user-initiated kill never detaches.
    if (shouldDetachAgentProcess(server.process.pid, reason)) {
      this.logger.info(
        generationLogContext(server),
        "Detach-stop: leaving OpenCode server generation running",
      );
      return;
    }
    const result = await this.terminateProcess(server.process, {
      gracefulTimeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.logger.warn(
          { timeoutMs: OPENCODE_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          "OpenCode server did not exit after SIGTERM; sending SIGKILL",
        );
      },
    });
    if (result === "kill-timeout") {
      this.logger.warn(
        { timeoutMs: OPENCODE_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS },
        "OpenCode server did not report exit after SIGKILL",
      );
    }
    if (server.managedProcessId) {
      await this.removeManagedProcessId(server.managedProcessId);
      server.managedProcessId = undefined;
      server.managedProcessRecord = undefined;
    } else {
      this.removeManagedServerRecord(server);
    }
  }

  private async recordManagedServerProcess(options: {
    process: ChildProcess;
    command: string;
    args: string[];
    port: number;
  }): Promise<{ id: string } | null> {
    const pid = options.process.pid;
    if (!this.managedProcesses || typeof pid !== "number" || pid <= 0) {
      return null;
    }

    try {
      return await this.managedProcesses.record({
        owner: { provider: "opencode", kind: "helper-server" },
        pid,
        command: options.command,
        args: options.args,
        metadata: { port: options.port },
      });
    } catch (error) {
      this.logger.warn(
        { err: error, pid, port: options.port },
        "Failed to record OpenCode helper process",
      );
      return null;
    }
  }

  private removeManagedProcessRecordWhenResolved(record: Promise<{ id: string } | null>): void {
    void record.then((resolved) => {
      if (resolved) {
        return this.removeManagedProcessId(resolved.id);
      }
      return undefined;
    });
  }

  private removeManagedServerRecord(server: OpenCodeServerGeneration): void {
    const record = server.managedProcessRecord;
    server.managedProcessRecord = undefined;
    if (server.managedProcessId) {
      void this.removeManagedProcessId(server.managedProcessId);
      server.managedProcessId = undefined;
      return;
    }
    if (record) {
      this.removeManagedProcessRecordWhenResolved(record);
    }
  }

  private async removeManagedProcessId(id: string): Promise<void> {
    try {
      await this.managedProcesses?.remove(id);
    } catch (error) {
      this.logger.warn({ err: error, id }, "Failed to remove OpenCode helper process record");
    }
  }
}

function generationLogContext(server: OpenCodeServerGeneration): Record<string, unknown> {
  return {
    pid: server.process.pid,
    port: server.port,
    url: server.url,
    refCount: server.refCount,
    retired: server.retired,
  };
}

async function waitForServerAcquisition<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return await operation;
  let handleAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    handleAbort = () => reject(signal.reason);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (handleAbort) signal.removeEventListener("abort", handleAbort);
  }
}

async function resolveOpenCodeBinary(): Promise<string> {
  const found = await findExecutable("opencode");
  if (!found) {
    throw new Error(
      "OpenCode binary not found. Install OpenCode (https://github.com/opencode-ai/opencode) and ensure it is available in your shell PATH.",
    );
  }

  if (process.platform === "win32" && path.extname(found).toLowerCase() === ".cmd") {
    const packageDirectories = [
      path.join(path.dirname(found), "node_modules", "opencode-ai"),
      path.join(path.dirname(found), "..", "opencode-ai"),
    ];
    for (const packageDirectory of packageDirectories) {
      const bundledBinary = path.join(packageDirectory, "bin", "opencode.exe");
      if (await pathExists(bundledBinary)) return bundledBinary;

      // Newer npm releases keep the executable in a platform dependency.
      // Resolve from the CLI package so nested installs and pnpm both work.
      try {
        const require = createRequire(path.join(packageDirectory, "package.json"));
        return require.resolve(`opencode-windows-${process.arch}/bin/opencode.exe`);
      } catch {
        // Try the other npm layout before retaining the original command.
      }
    }

    console.warn(
      "[opencode-server] Found opencode.cmd but could not resolve the real opencode.exe. " +
        "The process may not be properly terminated on exit. Path: %s",
      found,
    );
  }

  return found;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) {
          resolve(address.port);
        } else {
          reject(new Error("Failed to allocate port"));
        }
      });
    });
    server.on("error", reject);
  });
}
