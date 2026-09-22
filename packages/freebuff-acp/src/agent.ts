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
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { CodebuffClient } from "@codebuff/sdk";

import { resolveCredentials } from "./auth.js";
import { DEFAULT_MODE_ID, FREEBUFF_MODES, FREEBUFF_MODE_IDS } from "./modes.js";
import type { TurnResult } from "./turn.js";
import { runTurn } from "./turn.js";

interface ClientApi {
  sessionUpdate(params: SessionNotification): Promise<void>;
}

interface AdapterSession {
  id: string;
  cwd: string;
  modeId: string;
  client: CodebuffClient;
  /** Opaque SDK conversation state used to continue this session across prompts. */
  runState: Record<string, unknown> | null;
  busy: boolean;
  abortController: AbortController | null;
}

export class FreebuffAcpAgent {
  private readonly sessions = new Map<string, AdapterSession>();
  private sessionCounter = 0;
  private client: CodebuffClient | null = null;
  private readonly conn: ClientApi;
  private readonly env: NodeJS.ProcessEnv;

  constructor(conn: ClientApi, env: NodeJS.ProcessEnv = process.env) {
    this.conn = conn;
    this.env = env;
  }

  private ensureClient(cwd: string): CodebuffClient {
    if (this.client) return this.client;
    const credentials = resolveCredentials(this.env);
    if (!credentials) {
      throw new Error(
        "Freebuff is not authenticated. Run `freebuff login` (or `codebuff login`), " +
          "or set FREEBUFF_API_KEY / CODEBUFF_API_KEY in the provider environment.",
      );
    }
    this.client = new CodebuffClient({
      apiKey: credentials.apiKey,
      cwd,
    });
    return this.client;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
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
    const client = this.ensureClient(params.cwd);
    const sessionId = `freebuff-${++this.sessionCounter}-${Date.now().toString(36)}`;
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd: params.cwd,
      modeId: DEFAULT_MODE_ID,
      client,
      runState: null,
      busy: false,
      abortController: null,
    });
    return {
      sessionId,
      modes: {
        availableModes: FREEBUFF_MODES,
        currentModeId: DEFAULT_MODE_ID,
      },
    };
  }

  async loadSession(_params: LoadSessionRequest): Promise<LoadSessionResponse> {
    // Freebuff conversations live server-side and are only resumable through an
    // in-process RunState, which does not survive adapter restarts. The
    // capability is not advertised, so hosts should never call this.
    throw new Error("loadSession is not supported by freebuff-acp");
  }

  async setSessionMode(params: { sessionId: string; modeId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session: ${params.sessionId}`);
    if (!FREEBUFF_MODE_IDS.has(params.modeId)) {
      throw new Error(`Unknown mode: ${params.modeId}`);
    }
    session.modeId = params.modeId;
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
      const result: TurnResult = await runTurn({
        client: session.client,
        cwd: session.cwd,
        prompt: promptText,
        previousRun: session.runState,
        signal: abortController.signal,
        emit: (update) => {
          void this.conn
            .sessionUpdate({ sessionId: session.id, update } as unknown as SessionNotification)
            .catch(() => {
              // Stream updates are best-effort; the prompt result carries the outcome.
            });
        },
      });
      session.runState = result.runState;
      return { stopReason: result.stopReason };
    } finally {
      session.busy = false;
      session.abortController = null;
    }
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
