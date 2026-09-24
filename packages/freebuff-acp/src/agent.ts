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
  type ListSessionsRequest,
  type ListSessionsResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
} from "@agentclientprotocol/sdk";
import { CodebuffClient, type MessageContent } from "@codebuff/sdk";

import { createAskUserTool } from "./ask-user.js";
import { resolveCredentials } from "./auth.js";
import {
  buildAvailableCommands,
  discoverSkillCommands,
  helpText,
  parseSlashCommand,
  skillCommandPrompt,
  type SkillCommand,
} from "./commands.js";
import type { SessionOpenInfo } from "./freebuff-session.js";
import { resolveRunMcpServers } from "./mcp.js";
import { DEFAULT_MODE_ID, FREEBUFF_MODES, FREEBUFF_MODE_IDS } from "./modes.js";
import { FREEBUFF_MODEL_IDS, initialModelId, modelState } from "./models.js";
import {
  listPersistedSessions,
  loadPersistedSession,
  savePersistedSession,
} from "./session-store.js";
import { createAbortableTerminalTool } from "./terminal.js";
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
  /** Catalog model requested for this session's next admission. */
  modelId: string;
  /** Short title derived from the first prompt; published via session_info_update. */
  title?: string;
  /** Skills discovered for this workspace (slash commands). */
  skills: SkillCommand[];
  client: CodebuffClient;
  /** Backend auth token for the free-session admission dance. */
  token: string;
  /** Opaque SDK conversation state used to continue this session across prompts. */
  runState: Record<string, unknown> | null;
  busy: boolean;
  abortController: AbortController | null;
  /** Settles when the in-flight prompt has fully unwound (busy cleared). */
  inflight: Promise<void> | null;
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
  /**
   * The turn currently executing (the lane guarantees at most one). The
   * abortable terminal tool reads it to learn which signal/cwd to honor.
   */
  private activeTurn: { cwd: string; signal: AbortSignal; sessionId: string } | null = null;

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
        overrideTools: {
          run_terminal_command: createAbortableTerminalTool(() => this.activeTurn),
          ask_user: createAskUserTool(() =>
            this.activeTurn
              ? {
                  sessionId: this.activeTurn.sessionId,
                  requestPermission: (params) => this.conn.requestPermission(params),
                }
              : null,
          ),
        },
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
          // Lets hosts list/import sessions persisted by this adapter.
          list: {},
        },
        promptCapabilities: {
          audio: false,
          embeddedContext: false,
          image: true,
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
    const modelId = initialModelId(this.env);
    const session: AdapterSession = {
      id: sessionId,
      cwd: params.cwd,
      modeId: DEFAULT_MODE_ID,
      modelId,
      skills: [],
      client,
      token,
      runState: null,
      busy: false,
      abortController: null,
      inflight: null,
      // Host mcpServers (Paseo injects `paseo`, etc.) + session cwd mcp.json.
      mcpServers: resolveRunMcpServers(hostMcpServers, params.cwd),
      hostMcpServers,
    };
    this.sessions.set(sessionId, session);
    this.persist(session);
    this.scheduleCommandsPublish(session);
    return {
      sessionId,
      modes: {
        availableModes: FREEBUFF_MODES,
        currentModeId: DEFAULT_MODE_ID,
      },
      models: modelState(modelId),
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
    return this.sessionState(session);
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
    return this.sessionState(session);
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
      modelId: persisted?.modelId || initialModelId(this.env),
      ...(persisted?.title ? { title: persisted.title } : {}),
      skills: [],
      client,
      token,
      runState: persisted?.runState ?? null,
      busy: false,
      abortController: null,
      inflight: null,
      mcpServers: resolveRunMcpServers(hostMcpServers ?? [], sessionCwd),
      hostMcpServers,
    };
    this.sessions.set(sessionId, session);
    this.persist(session);
    this.scheduleCommandsPublish(session);
    return session;
  }

  private persist(session: AdapterSession): void {
    savePersistedSession(
      {
        sessionId: session.id,
        cwd: session.cwd,
        modeId: session.modeId,
        modelId: session.modelId,
        ...(session.title ? { title: session.title } : {}),
        runState: session.runState,
        updatedAt: new Date().toISOString(),
      },
      this.env,
    );
  }

  private sessionState(session: AdapterSession) {
    return { ...this.modeState(session.modeId), models: modelState(session.modelId) };
  }

  /**
   * Discover skills and announce the slash commands. Deferred to a macrotask
   * so the session/new response reaches the host before the notification.
   */
  private scheduleCommandsPublish(session: AdapterSession): void {
    setTimeout(() => {
      void this.publishCommands(session);
    }, 0);
  }

  private async publishCommands(session: AdapterSession): Promise<void> {
    try {
      session.skills = await discoverSkillCommands(session.cwd);
      await this.conn.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: buildAvailableCommands(session.skills),
        },
      } as unknown as SessionNotification);
    } catch {
      // Commands are a convenience; a failed announce must never break a session.
    }
  }

  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session: ${params.sessionId}`);
    if (!FREEBUFF_MODEL_IDS.has(params.modelId)) {
      throw new Error(`Unknown model: ${params.modelId}`);
    }
    session.modelId = params.modelId;
    this.persist(session);
    return {};
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const sessions = listPersistedSessions(this.env, params.cwd).map((persisted) => ({
      sessionId: persisted.sessionId,
      cwd: persisted.cwd,
      title: persisted.title ?? null,
      updatedAt: persisted.updatedAt || null,
    }));
    return { sessions };
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
    this.persist(session);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session: ${params.sessionId}`);

    const { text: rawText, images } = promptBlocksToParts(params.prompt);
    let promptText = rawText;

    // Slash commands: built-ins answer locally; skill commands rewrite the prompt.
    const command = parseSlashCommand(rawText, session.skills);
    if (command?.kind === "builtin") {
      return this.runBuiltinCommand(session, command.name);
    }
    if (command?.kind === "skill") {
      promptText = skillCommandPrompt(command.name, command.args);
    }

    // Steer: a prompt arriving mid-turn supersedes the running one. Stop it
    // and wait for it to unwind so the two turns never share the session's
    // RunState. (Paseo's ACP steer is cancel + new prompt; refusing here made
    // the follow-up race the cancelled turn's teardown and fail as "busy".)
    // Only yield when something is actually running: an idle session must
    // install its abort controller synchronously, or a cancel that arrives
    // right behind the prompt would find nothing to abort.
    if (session.busy) await this.stopRunningTurn(session);

    const content: MessageContent[] | undefined =
      images.length > 0
        ? [
            { type: "text", text: promptText },
            ...images.map(
              (image): MessageContent => ({
                type: "image",
                image: image.data,
                mediaType: image.mimeType,
              }),
            ),
          ]
        : undefined;

    session.busy = true;
    const abortController = new AbortController();
    session.abortController = abortController;
    let markUnwound: () => void = () => undefined;
    session.inflight = new Promise<void>((resolve) => {
      markUnwound = resolve;
    });

    try {
      this.maybePublishTitle(session, rawText);
      // Queue this turn onto the process-wide lane instead of running it
      // immediately: only one runTurn (and its global metadata hook) may be
      // in flight across all sessions at once.
      const task = this.turnLane.then(async (): Promise<TurnResult> => {
        if (abortController.signal.aborted) {
          // Cancelled while queued: never start admission for a turn the
          // caller already gave up on.
          return { stopReason: "cancelled", runState: session.runState };
        }
        this.activeTurn = {
          cwd: session.cwd,
          signal: abortController.signal,
          sessionId: session.id,
        };
        const emit = (update: Record<string, unknown> & { sessionUpdate: string }) => {
          void this.conn
            .sessionUpdate({ sessionId: session.id, update } as unknown as SessionNotification)
            .catch(() => {
              // Stream updates are best-effort; the prompt result carries the outcome.
            });
        };
        try {
          return await runTurn({
            client: session.client,
            cwd: session.cwd,
            prompt: promptText,
            ...(content ? { content } : {}),
            previousRun: session.runState,
            signal: abortController.signal,
            token: session.token,
            model: session.modelId,
            mcpServers: session.mcpServers,
            confirmSessionOpen: (info) => this.confirmSessionOpen(session.id, info),
            emit,
          });
        } finally {
          this.activeTurn = null;
        }
      });
      // Advance the lane past this turn regardless of outcome, so a
      // rejected turn never wedges the queue for every session after it.
      this.turnLane = task.then(
        () => undefined,
        () => undefined,
      );

      const result: TurnResult = await task;
      session.runState = result.runState;
      this.adoptAdmittedModel(session, result.admittedModel);
      this.persist(session);
      return {
        stopReason: result.stopReason,
        ...(result.contextTokens !== undefined || result.creditsUsed !== undefined
          ? {
              _meta: {
                freebuff: {
                  model: session.modelId,
                  contextTokens: result.contextTokens,
                  creditsUsed: result.creditsUsed,
                },
              },
            }
          : {}),
      };
    } finally {
      session.busy = false;
      session.abortController = null;
      session.inflight = null;
      markUnwound();
    }
  }

  /** Abort the session's running turn (if any) and wait for it to unwind. */
  private async stopRunningTurn(session: AdapterSession): Promise<void> {
    while (session.busy) {
      session.abortController?.abort();
      await session.inflight;
    }
  }

  private sendMessage(session: AdapterSession, text: string): void {
    void this.conn
      .sessionUpdate({
        sessionId: session.id,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      } as unknown as SessionNotification)
      .catch(() => {
        // Best-effort, like every stream update.
      });
  }

  private async runBuiltinCommand(
    session: AdapterSession,
    name: "help" | "status" | "clear" | "skills",
  ): Promise<PromptResponse> {
    switch (name) {
      case "help":
        this.sendMessage(session, helpText(session.skills));
        break;
      case "skills":
        this.sendMessage(
          session,
          session.skills.length > 0
            ? session.skills.map((skill) => `- /${skill.name} — ${skill.description}`).join("\n")
            : "No skills found in ~/.agents/skills or .agents/skills.",
        );
        break;
      case "status":
        this.sendMessage(
          session,
          [
            `Session: ${session.id}`,
            `Model: ${session.modelId}`,
            `Working directory: ${session.cwd}`,
            `Conversation: ${session.runState ? "in progress" : "empty"}`,
          ].join("\n"),
        );
        break;
      case "clear":
        await this.stopRunningTurn(session);
        session.runState = null;
        this.persist(session);
        this.sendMessage(session, "Conversation cleared.");
        break;
    }
    return { stopReason: "end_turn" };
  }

  /** Publish a title from the first prompt so the host can label the session. */
  private maybePublishTitle(session: AdapterSession, promptText: string): void {
    if (session.title) return;
    const title = promptText.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!title) return;
    session.title = title;
    void this.conn
      .sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "session_info_update",
          title,
          updatedAt: new Date().toISOString(),
        },
      } as unknown as SessionNotification)
      .catch(() => {
        // Best-effort.
      });
  }

  /**
   * An already-open free slot may be locked to another catalog model, which
   * the turn must adopt. Keep the session in step and tell the user, so the
   * model shown in the host never silently disagrees with what ran.
   */
  private adoptAdmittedModel(session: AdapterSession, admittedModel: string | undefined): void {
    if (!admittedModel || admittedModel === session.modelId) return;
    this.sendMessage(
      session,
      `\n\n_Note: the open Freebuff slot is locked to ${admittedModel}, so this turn ran on it instead of ${session.modelId}._`,
    );
    session.modelId = admittedModel;
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

interface PromptParts {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
}

function promptBlocksToParts(blocks: ContentBlock[]): PromptParts {
  const parts: string[] = [];
  const images: PromptParts["images"] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;
      case "image":
        images.push({ data: block.data, mimeType: block.mimeType });
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
  return { text: parts.join("\n\n"), images };
}
