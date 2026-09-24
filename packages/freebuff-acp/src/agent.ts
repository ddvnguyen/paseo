/**
 * freebuff-acp — Agent Client Protocol (ACP) adapter for Freebuff.
 *
 * Bridges the ACP JSON-RPC stdio protocol to the Codebuff/Freebuff backend via
 * `@codebuff/sdk`. This lets any ACP host — including Paseo, Zed, and others —
 * drive Freebuff as a first-class agent.
 *
 * Auth: `FREEBUFF_API_KEY` / `CODEBUFF_API_KEY` env, falling back to the
 * logged-in Freebuff CLI's `~/.config/manicode/credentials.json`.
 */
import {
  type ContentBlock,
  type AuthenticateRequest,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { CodebuffClient } from "@codebuff/sdk";

import { resolveCredentials } from "./auth.js";
import type { SessionOpenInfo } from "./freebuff-session.js";
import { resolveRunMcpServers } from "./mcp.js";
import { DEFAULT_MODE_ID, FREEBUFF_MODES, FREEBUFF_MODE_IDS } from "./modes.js";
import { nextConversationState } from "./run-state.js";
import { loadPersistedSession, savePersistedSession } from "./session-store.js";
import type { TurnResult } from "./turn.js";
import { runTurn } from "./turn.js";

interface ClientApi {
  sessionUpdate(params: SessionNotification): Promise<void>;
  /**
   * Ask the host to approve an action (ACP session/request_permission).
   * Return typed loosely: the schema narrows `outcome`, but the adapter only
   * discriminates on it, and the loose shape keeps test fakes assignable.
   */
  requestPermission(
    params: RequestPermissionRequest,
  ): Promise<{ outcome: { outcome: string; optionId?: string } }>;
}

interface AdapterSession {
  id: string;
  cwd: string;
  modeId: string;
  client: CodebuffClient;
  /** Backend auth token for the free-session admission dance. */
  token: string;
  /** Opaque SDK conversation state used to continue this session across prompts. */
  runState: Record<string, unknown> | null;
  busy: boolean;
  abortController: AbortController | null;
  /** Host-injected MCP servers from session/new, merged with .agents/mcp.json. */
  mcpServers: ReturnType<typeof resolveRunMcpServers>;
  /** ACP mcpServers from resume/load (host-injected only; no mcp.json merge yet). */
  hostMcpServers?: NewSessionRequest["mcpServers"];
}

export class FreebuffAcpAgent {
  private readonly sessions = new Map<string, AdapterSession>();
  private sessionCounter = 0;
  private client: CodebuffClient | null = null;
  private readonly conn: ClientApi;
  private readonly env: NodeJS.ProcessEnv;
  /**
   * Process-wide turn queue. turn.ts pins a single global hook
   * (`__freebuffExtraCodebuffMetadata`) around each `client.run()` call, so
   * two sessions prompting concurrently in this process would bleed instance
   * ids into each other's run. All turns funnel through this lane so only
   * one `runTurn` is in flight at a time, regardless of session.
   */
  private turnLane: Promise<void> = Promise.resolve();

  constructor(conn: ClientApi, env: NodeJS.ProcessEnv = process.env) {
    this.conn = conn;
    this.env = env;
  }

  private ensureClient(cwd: string): { client: CodebuffClient; token: string } {
    const credentials = resolveCredentials(this.env);
    if (!credentials) {
      throw new Error(
        "Freebuff is not authenticated. Run `freebuff login` (or `codebuff login`), " +
          "or set FREEBUFF_API_KEY / CODEBUFF_API_KEY in the provider environment.",
      );
    }
    if (!this.client) {
      this.client = new CodebuffClient({
        apiKey: credentials.apiKey,
        cwd,
      });
    }
    return { client: this.client, token: credentials.apiKey };
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        // History replay is not supported (SDK RunState is opaque); hosts that
        // only need to continue a conversation use session/resume instead.
        loadSession: false,
        sessionCapabilities: {
          // Unstable ACP resume: restore context without replaying messages.
          // Paseo prefers loadSession when present, else this path — so open
          // sessions are not blocked after an adapter restart.
          resume: {},
        },
        promptCapabilities: {
          audio: false,
          embeddedContext: false,
          image: false,
        },
      },
      authMethods: [
        {
          id: "freebuff-login",
          name: "Freebuff CLI login",
          description:
            "Uses the credentials from `freebuff login` (~/.config/manicode/credentials.json), " +
            "or set FREEBUFF_API_KEY / CODEBUFF_API_KEY.",
        },
      ],
    };
  }

  async authenticate(params: AuthenticateRequest): Promise<void> {
    if (params.methodId && params.methodId !== "freebuff-login") {
      throw new Error(`Unknown auth method: ${params.methodId}`);
    }
    if (!resolveCredentials(this.env)) {
      throw new Error(
        "Freebuff is not authenticated. Run `freebuff login` (or `codebuff login`), " +
          "or set FREEBUFF_API_KEY / CODEBUFF_API_KEY.",
      );
    }
    // Credentials are re-resolved lazily on the next newSession.
    this.client = null;
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const { client, token } = this.ensureClient(params.cwd);
    const sessionId = `freebuff-${++this.sessionCounter}-${Date.now().toString(36)}`;
    const hostMcpServers = params.mcpServers;
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd: params.cwd,
      modeId: DEFAULT_MODE_ID,
      client,
      token,
      runState: null,
      busy: false,
      abortController: null,
      // Host mcpServers (Paseo injects `paseo`, etc.) + session cwd mcp.json.
      mcpServers: resolveRunMcpServers(hostMcpServers, params.cwd),
      hostMcpServers,
    });
    savePersistedSession(
      {
        sessionId,
        cwd: params.cwd,
        modeId: DEFAULT_MODE_ID,
        runState: null,
        updatedAt: new Date().toISOString(),
      },
      this.env,
    );
    return {
      sessionId,
      modes: {
        availableModes: FREEBUFF_MODES,
        currentModeId: DEFAULT_MODE_ID,
      },
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    // History replay is intentionally unsupported (opaque RunState). Advertise
    // session/resume instead; if a host still calls loadSession, restore
    // context without emitting past messages so resume never hard-fails.
    const session = await this.restoreSession(
      params.sessionId,
      params.cwd,
      params.mcpServers ?? [],
    );
    return this.modeState(session.modeId);
  }

  /**
   * Restore an open conversation after an adapter restart (ACP session/resume).
   * Rehydrates RunState from the on-disk session store so the next prompt
   * continues the same thread instead of erroring on an unknown sessionId.
   */
  async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const session = await this.restoreSession(
      params.sessionId,
      params.cwd,
      params.mcpServers ?? [],
    );
    return this.modeState(session.modeId);
  }

  private async restoreSession(
    sessionId: string,
    cwd: string,
    hostMcpServers: NewSessionRequest["mcpServers"] | undefined,
  ): Promise<AdapterSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const { client, token } = this.ensureClient(cwd);
    const persisted = loadPersistedSession(sessionId, this.env);
    const modeId =
      persisted?.modeId && FREEBUFF_MODE_IDS.has(persisted.modeId)
        ? persisted.modeId
        : DEFAULT_MODE_ID;
    const sessionCwd = persisted?.cwd || cwd;
    const session: AdapterSession = {
      id: sessionId,
      cwd: sessionCwd,
      modeId,
      client,
      token,
      runState: persisted?.runState ?? null,
      busy: false,
      abortController: null,
      mcpServers: resolveRunMcpServers(hostMcpServers ?? [], sessionCwd),
      hostMcpServers,
    };
    this.sessions.set(sessionId, session);
    savePersistedSession(
      {
        sessionId,
        cwd: sessionCwd,
        modeId,
        runState: session.runState,
        updatedAt: new Date().toISOString(),
      },
      this.env,
    );
    return session;
  }

  private modeState(modeId: string): {
    modes: { availableModes: typeof FREEBUFF_MODES; currentModeId: string };
  } {
    return {
      modes: {
        availableModes: FREEBUFF_MODES,
        currentModeId: FREEBUFF_MODE_IDS.has(modeId) ? modeId : DEFAULT_MODE_ID,
      },
    };
  }

  async setSessionMode(params: { sessionId: string; modeId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session: ${params.sessionId}`);
    if (!FREEBUFF_MODE_IDS.has(params.modeId)) {
      throw new Error(`Unknown mode: ${params.modeId}`);
    }
    session.modeId = params.modeId;
    savePersistedSession(
      {
        sessionId: session.id,
        cwd: session.cwd,
        modeId: session.modeId,
        runState: session.runState,
        updatedAt: new Date().toISOString(),
      },
      this.env,
    );
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session: ${params.sessionId}`);
    if (session.busy) {
      throw new Error("Session is busy; cancel the running turn first.");
    }

    const promptText = promptBlocksToText(params.prompt);
    session.busy = true;
    const abortController = new AbortController();
    session.abortController = abortController;

    try {
      // Queue this turn onto the process-wide lane instead of running it
      // immediately: only one runTurn (and its global metadata hook) may be
      // in flight across all sessions at once.
      const task = this.turnLane.then((): Promise<TurnResult> | TurnResult => {
        if (abortController.signal.aborted) {
          // Cancelled while queued: never start admission for a turn the
          // caller already gave up on.
          return { stopReason: "cancelled", runState: session.runState };
        }
        return runTurn({
          client: session.client,
          cwd: session.cwd,
          prompt: promptText,
          previousRun: session.runState,
          signal: abortController.signal,
          token: session.token,
          model: this.env.FREEBUFF_MODEL?.trim() || undefined,
          mcpServers: session.mcpServers,
          confirmSessionOpen: (info) => this.confirmSessionOpen(session.id, info),
          emit: (update) => {
            void this.conn
              .sessionUpdate({ sessionId: session.id, update } as unknown as SessionNotification)
              .catch(() => {
                // Stream updates are best-effort; the prompt result carries the outcome.
              });
          },
        });
      });
      // Advance the lane past this turn regardless of outcome, so a
      // rejected turn never wedges the queue for every session after it.
      this.turnLane = task.then(
        () => undefined,
        () => undefined,
      );

      const result: TurnResult = await task;
      session.runState = nextConversationState(session.runState, result.runState, result.stopReason);
      savePersistedSession(
        {
          sessionId: session.id,
          cwd: session.cwd,
          modeId: session.modeId,
          runState: session.runState,
          updatedAt: new Date().toISOString(),
        },
        this.env,
      );
      return { stopReason: result.stopReason };
    } finally {
      session.busy = false;
      session.abortController = null;
    }
  }

  /**
   * Ask the host to approve opening a NEW free session before the admission
   * POST spends credit (one slot = 1 hour). Fails closed: a thrown request
   * or any selection other than `open-session` declines the spend.
   */
  private async confirmSessionOpen(sessionId: string, info: SessionOpenInfo): Promise<boolean> {
    const cost = info.priceFreebucks != null ? `${info.priceFreebucks} Freebucks` : "Freebucks";
    const left =
      info.dailyRemaining != null ? ` — ${info.dailyRemaining} Freebucks left today` : "";
    const response = await this.conn.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: `freebuff-open-${crypto.randomUUID()}`,
        title: "Open new Freebuff session",
        status: "pending",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `No active Freebuff session. Opening one for ${info.model} costs ${cost} and lasts 1 hour${left}.`,
            },
          },
        ],
      },
      options: [
        {
          optionId: "open-session",
          name: `Open session — ${cost}, valid 1 hour`,
          kind: "allow_once",
        },
        { optionId: "cancel-open", name: "Cancel (no credit spent)", kind: "reject_once" },
      ],
    });
    return response.outcome.outcome === "selected" && response.outcome.optionId === "open-session";
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) return;
    session.abortController?.abort();
  }
}

function promptBlocksToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "resource_link":
        parts.push(`[link] ${block.uri}`);
        break;
      case "resource": {
        const resource = block.resource;
        if ("text" in resource && typeof resource.text === "string") {
          parts.push(`[resource ${resource.uri}]\n${resource.text}`);
        } else {
          parts.push(`[resource ${resource.uri}]`);
        }
        break;
      }
      default:
        break;
    }
  }
  return parts.join("\n\n");
}
