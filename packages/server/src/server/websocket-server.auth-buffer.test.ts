import { afterEach, describe, expect, test, vi } from "vitest";
import type { Server as HTTPServer } from "http";
import type pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import { SessionDelivery } from "./session/owned-subscriptions/index.js";
import { parseServerInfoStatusPayload } from "./messages.js";
import { hashDaemonPassword } from "./auth.js";

type SocketListener = (...args: unknown[]) => void;

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    static instances: MockWebSocketServer[] = [];
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    constructor(_options: unknown) {
      MockWebSocketServer.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

const sessionMock = vi.hoisted(() => {
  const instances: MockSession[] = [];

  class MockSession {
    readonly delivery = new SessionDelivery((source, message) => {
      const send = this.args.onMessageToSource as (source: object, message: unknown) => void;
      send(source, message);
    });
    cleanup = vi.fn(async () => {
      await this.delivery.close();
    });
    handleMessage = vi.fn(async () => {});
    handleBinaryFrame = vi.fn((_frame: unknown) => {});
    supports = vi.fn((capability: string) => this.args.clientCapabilities?.[capability] === true);
    updateClientCapabilities = vi.fn(
      (capabilities: Record<string, unknown> | null, source: object) => {
        this.args.clientCapabilities = capabilities;
        this.delivery.attach(source, capabilities?.owned_subscriptions === true);
      },
    );
    clearAgentTimelineSubscription = vi.fn((source: object) => {
      void this.delivery.detach(source);
    });
    getClientActivity = vi.fn(() => null);
    wantsSourceEvent = (source: object) => !this.delivery.isModern(source);
    getSessionId = vi.fn(() => "mock-session-id");
    getPermissions = vi.fn(() => this.args.permissions as string[]);
    allowsInbound = vi.fn(() => true);
    allowsPermission = vi.fn(() => true);
    publish = vi.fn((message: unknown) => {
      const onMessage = this.args.onMessage as ((message: unknown) => void) | undefined;
      onMessage?.(message);
    });
    resetPeakInflight = vi.fn(() => {});
    getRuntimeMetrics = vi.fn(() => ({
      checkoutDiffTargetCount: 0,
      checkoutDiffSubscriptionCount: 0,
      checkoutDiffWatcherCount: 0,
      terminalDirectorySubscriptionCount: 0,
      terminalSubscriptionCount: 0,
      inflightRequests: 0,
      peakInflightRequests: 0,
    }));
    readonly args: Record<string, unknown>;

    constructor(args: Record<string, unknown>) {
      this.args = args;
      instances.push(this);
    }
  }

  return { MockSession, instances };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: sessionMock.MockSession,
}));

vi.mock("./push/index.js", () => ({
  createPushNotifications: () => ({
    renew: () => undefined,
    revoke: () => undefined,
    send: async () => undefined,
  }),
}));

import {
  deferSocketMessages,
  socketSupportsPause,
  VoiceAssistantWebSocketServer,
} from "./websocket-server";

interface AuthSocketInternals {
  attachAuthenticatedSocket(ws: unknown, req: unknown, password: string | undefined): Promise<void>;
}

/** Mimics Bun 1.4.2's native-backed server socket: EventEmitter surface, no pause()/resume(). */
class MockSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  closedCode: number | null = null;
  closeReason: string | null = null;
  private listeners = new Map<string, SocketListener[]>();

  on(event: "message" | "close" | "error", listener: SocketListener): void {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(listener);
    this.listeners.set(event, handlers);
  }

  once(event: "close" | "error", listener: SocketListener): void {
    const wrapped: SocketListener = (...args) => {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((handler) => handler !== wrapped),
      );
      listener(...args);
    };
    this.on(event, wrapped);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedCode = code ?? 1000;
    this.closeReason = reason ?? "";
    this.readyState = 3;
    this.emit("close", this.closedCode, this.closeReason);
  }

  emit(event: "message" | "close" | "error", ...args: unknown[]): void {
    for (const handler of (this.listeners.get(event) ?? []).slice()) {
      handler(...args);
    }
  }
}

/** Node-`ws` socket shape: MockSocket plus pause()/resume() with real hold semantics. */
class PausableMockSocket extends MockSocket {
  private paused = false;
  private held: unknown[][] = [];
  readonly pause = vi.fn(() => {
    this.paused = true;
  });
  readonly resume = vi.fn(() => {
    this.paused = false;
    for (const args of this.held.splice(0, this.held.length)) {
      super.emit("message", ...args);
    }
  });

  override emit(event: "message" | "close" | "error", ...args: unknown[]): void {
    if (event === "message" && this.paused) {
      this.held.push(args);
      return;
    }
    super.emit(event, ...args);
  }
}

function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createServer() {
  const logger = createLogger();
  return new VoiceAssistantWebSocketServer(
    createStub<HTTPServer>({}),
    createStub<pino.Logger>(logger),
    "srv_test",
    createStub<AgentManager>({
      subscribe: vi.fn(() => () => {}),
      setAgentAttentionCallback: vi.fn(),
      getAgent: vi.fn(() => null),
      getMetricsSnapshot: vi.fn(() => ({
        totalAgents: 0,
        idleAgents: 0,
        runningAgents: 0,
        pendingPermissionAgents: 0,
        erroredAgents: 0,
      })),
    }),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    "/tmp/paseo-test",
    createStub<DaemonConfigStore>({
      onApply: vi.fn(() => () => {}),
      onChange: vi.fn(() => () => {}),
    }),
    null,
    { allowedOrigins: new Set() },
    createStub<WorkspaceAutoName>({
      scheduleForWorktree: () => {},
      scheduleForDirectory: () => {},
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createProviderSnapshotManagerStub().manager,
  );
}

function createHelloMessage(clientId: string) {
  return {
    type: "hello" as const,
    clientId,
    clientType: "cli" as const,
    protocolVersion: 1,
  };
}

function createHeaderAuthRequest(token: string) {
  return {
    headers: {
      host: "localhost:6767",
      origin: "http://localhost:6767",
      "user-agent": "vitest",
      "sec-websocket-protocol": `paseo.bearer.${token}`,
    },
    socket: {
      remoteAddress: "127.0.0.1",
    },
    url: "/ws",
  };
}

function sentServerInfoCount(socket: MockSocket): number {
  let count = 0;
  for (const data of socket.sent) {
    if (typeof data !== "string") continue;
    try {
      const envelope = JSON.parse(data) as {
        type?: string;
        message?: { type?: string; payload?: unknown };
      };
      if (
        envelope.type === "session" &&
        envelope.message?.type === "status" &&
        parseServerInfoStatusPayload(envelope.message.payload) !== null
      ) {
        count += 1;
      }
    } catch {
      // Non-JSON frames are not hello acknowledgements.
    }
  }
  return count;
}

afterEach(() => {
  sessionMock.instances.length = 0;
  wsModuleMock.MockWebSocketServer.instances.length = 0;
});

describe("attachAuthenticatedSocket auth buffering", () => {
  test("socketSupportsPause distinguishes ws sockets from Bun-native sockets", () => {
    expect(socketSupportsPause(new PausableMockSocket())).toBe(true);
    expect(socketSupportsPause(new MockSocket())).toBe(false);
  });

  test("deferSocketMessages replays held frames in order and then lets go", () => {
    const socket = new MockSocket();
    const seen: unknown[] = [];
    const deferred = deferSocketMessages(socket, (data) => seen.push(data));
    socket.emit("message", "first");
    socket.emit("message", "second");
    expect(seen).toEqual([]);
    deferred.release();
    expect(seen).toEqual(["first", "second"]);
    // Idempotent: a second release replays nothing.
    deferred.release();
    expect(seen).toEqual(["first", "second"]);
  });

  test("deferSocketMessages discard drops held frames", () => {
    const socket = new MockSocket();
    const seen: unknown[] = [];
    const deferred = deferSocketMessages(socket, (data) => seen.push(data));
    socket.emit("message", "dropped");
    deferred.discard();
    expect(seen).toEqual([]);
    deferred.release();
    expect(seen).toEqual([]);
  });

  test("eager hello survives async header auth on sockets without pause() (Bun path)", async () => {
    const server = createServer();
    try {
      const socket = new MockSocket();
      expect(socketSupportsPause(socket)).toBe(false);
      const passwordHash = hashDaemonPassword("correct-password");
      const internals = asInternals<AuthSocketInternals>(server);
      // Invoke without awaiting: the hello below lands while bcrypt comparison
      // is still in flight, exactly the window pause() used to cover.
      const attached = internals.attachAuthenticatedSocket(
        socket,
        createHeaderAuthRequest("correct-password"),
        passwordHash,
      );
      socket.emit("message", JSON.stringify(createHelloMessage("eager-bun-client")));
      await attached;
      await vi.waitFor(() => expect(sentServerInfoCount(socket)).toBe(1));
      expect(socket.readyState).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("eager hello uses pause()/resume() when the socket supports them (Node path)", async () => {
    const server = createServer();
    try {
      const socket = new PausableMockSocket();
      expect(socketSupportsPause(socket)).toBe(true);
      const passwordHash = hashDaemonPassword("correct-password");
      const internals = asInternals<AuthSocketInternals>(server);
      const attached = internals.attachAuthenticatedSocket(
        socket,
        createHeaderAuthRequest("correct-password"),
        passwordHash,
      );
      socket.emit("message", JSON.stringify(createHelloMessage("eager-node-client")));
      await attached;
      await vi.waitFor(() => expect(sentServerInfoCount(socket)).toBe(1));
      expect(socket.pause).toHaveBeenCalledTimes(1);
      expect(socket.resume).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  test("rejected header auth discards buffered frames without pause() (Bun path)", async () => {
    const server = createServer();
    try {
      const socket = new MockSocket();
      const passwordHash = hashDaemonPassword("correct-password");
      const internals = asInternals<AuthSocketInternals>(server);
      const attached = internals.attachAuthenticatedSocket(
        socket,
        createHeaderAuthRequest("wrong-password"),
        passwordHash,
      );
      socket.emit("message", JSON.stringify(createHelloMessage("rejected-bun-client")));
      await attached;
      expect(socket.readyState).toBe(3);
      expect(socket.closedCode).toBe(4401);
      expect(sentServerInfoCount(socket)).toBe(0);
    } finally {
      await server.close();
    }
  });
});
