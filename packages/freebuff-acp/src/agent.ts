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
  type CloseSessionRequest,
  type CloseSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
} from "@agentclientprotocol/sdk";
import { CodebuffClient, type MessageContent } from "@codebuff/sdk";

import {
  DEFAULT_ACCOUNT_ID,
  accountDisplayName,
  credentialsForAccount,
  findAccount,
  listAccounts,
  type FreebuffAccount,
} from "./accounts.js";
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
import {
  ACCOUNT_CONFIG_ID,
  CONFIRM_OPEN_CONFIG_ID,
  MODEL_CONFIG_ID,
  buildConfigOptions,
  initialAccountId,
  fetchAccountStatus,
  initialConfirmOpenMode,
  isConfirmOpenMode,
  type AccountStatus,
  type ConfirmOpenMode,
} from "./account.js";
import type { ModelSwitchInfo, SessionOpenInfo } from "./freebuff-session.js";
import { resolveRunMcpServers } from "./mcp.js";
import { DEFAULT_MODE_ID, FREEBUFF_MODES, FREEBUFF_MODE_IDS } from "./modes.js";
import { FREEBUFF_MODEL_IDS, initialModelId, modelState } from "./models.js";
import {
  listPersistedSessions,
  pruneEmptyPersistedSessions,
  loadPersistedSession,
  savePersistedSession,
} from "./session-store.js";
import { clearedContextUsageUpdate, contextUsageUpdate } from "./context-usage.js";
import { runStateToReplayUpdates } from "./history-replay.js";
import { REQUIRE_APPROVAL_META } from "./permission-meta.js";
import { nextConversationState } from "./run-state.js";
import {
  checkpointForRewind,
  checkpointsAfterRewind,
  countUserTurns,
  recordCheckpoint,
  type RunStateCheckpoint,
} from "./rewind.js";
import { createAbortableTerminalTool } from "./terminal.js";
import type { TurnResult } from "./turn.js";
import { runTurn } from "./turn.js";

/**
 * F6 — per-turn hard timeout. A hung SDK call would otherwise wedge the
 * process-wide turn lane forever (cancel/steer/clear/close all hang behind
 * it). FREEBUFF_TURN_TIMEOUT_MS overrides the default; "0" disables.
 */
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
/** setTimeout() silently turns delays above 2^31-1 into 1ms; clamp instead. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/** F8 — upper bound for awaited quota refreshes so session open never stalls. */
const STATUS_REFRESH_TIMEOUT_MS = 5_000;

function logWarn(message: string): void {
  process.stderr.write(`freebuff-acp: ${message}\n`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** F8: a failed/timed-out quota refresh keeps the last known status. */
function ignoreStatusError(error: unknown): void {
  logWarn(`quota refresh failed: ${describeError(error)}; keeping the last known status.`);
}

/**
 * F6: per-turn hard timeout in milliseconds from FREEBUFF_TURN_TIMEOUT_MS.
 * Default 30 minutes; "0" disables the watchdog; an invalid value falls back
 * to the default (logged to stderr).
 */
export function resolveTurnTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.FREEBUFF_TURN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_TURN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    logWarn(
      `ignoring invalid FREEBUFF_TURN_TIMEOUT_MS "${raw}"; using the default ` +
        `${DEFAULT_TURN_TIMEOUT_MS}ms.`,
    );
    return DEFAULT_TURN_TIMEOUT_MS;
  }
  if (value > MAX_TIMEOUT_MS) {
    logWarn(`capping FREEBUFF_TURN_TIMEOUT_MS ${raw} to ${MAX_TIMEOUT_MS}ms.`);
    return MAX_TIMEOUT_MS;
  }
  return value;
}

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
  /** Registered account this session runs under (see accounts.ts). */
  accountId: string;
  /** Display name of the account (never the token). */
  accountName: string;
  /** Whether opening a new credit-spending session needs host approval. */
  confirmOpen: ConfirmOpenMode;
  /** Last quota/price snapshot from the server (null until fetched). */
  status: AccountStatus | null;
  /** Skills discovered for this workspace (slash commands). */
  skills: SkillCommand[];
  client: CodebuffClient;
  /** Backend auth token for the free-session admission dance. */
  token: string;
  /** Opaque SDK conversation state used to continue this session across prompts. */
  runState: Record<string, unknown> | null;
  /** Pre-turn conversation snapshots for rewind (see rewind.ts). */
  checkpoints: RunStateCheckpoint[];
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
  /**
   * F7: one SDK client per (account, cwd). The client bakes the cwd it was
   * created with, so the key must include the cwd — otherwise a second
   * session on another workspace would silently run against the first one.
   */
  private readonly clients = new Map<string, CodebuffClient>();
  /** F7: set once shutdown() has run; keeps it idempotent. */
  private shutdownRan = false;
  /** F7: set once this instance registered its process shutdown hooks. */
  private hooksInstalled = false;
  /** Latest quota per account id, for the account picker. */
  private readonly accountStatuses = new Map<string, AccountStatus | null>();
  private readonly conn: ClientApi;
  private readonly env: NodeJS.ProcessEnv;
  /**
   * Process-wide turn queue. The instance id now travels per run
   * (`extraCodebuffMetadata`), so nothing is shared between runs; the lane
   * stays because Freebuff grants one seat per account and admission/release
   * ordering across sessions is not yet safe to interleave. All turns funnel
   * through it so only one `runTurn` is in flight at a time.
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
    pruneEmptyPersistedSessions(this.env);
    // F7: teardown path for the long-lived adapter process. Tests opt out
    // (FREEBUFF_ACP_DISABLE_SHUTDOWN_HOOKS=1) to keep the runner unpolluted.
    if (this.env.FREEBUFF_ACP_DISABLE_SHUTDOWN_HOOKS !== "1") {
      this.installShutdownHooks();
    }
  }

  private ensureClient(
    cwd: string,
    account: FreebuffAccount,
  ): { client: CodebuffClient; token: string } {
    const credentials = credentialsForAccount(account, this.env);
    if (!credentials) {
      throw new Error(
        account.configDir === null
          ? "Freebuff is not authenticated. Run `freebuff login` (or `codebuff login`), " +
              "or set FREEBUFF_API_KEY / CODEBUFF_API_KEY in the provider environment."
          : `Freebuff account "${account.id}" has no credentials in ${account.configDir}. ` +
              `Run \`FREEBUFF_CONFIG_DIR=${account.configDir} freebuff login\`.`,
      );
    }
    const clientKey = `${account.id}\u0000${cwd}`;
    let client = this.clients.get(clientKey);
    if (!client) {
      client = new CodebuffClient({
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
      this.clients.set(clientKey, client);
    }
    return { client, token: credentials.apiKey };
  }

  /** The account a persisted/requested id names; the default when it no longer exists. */
  private resolveAccount(accountId: string | undefined): FreebuffAccount {
    return findAccount(accountId, this.env) ?? findAccount(DEFAULT_ACCOUNT_ID, this.env)!;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        // session/load restores the RunState and replays the visible history
        // (history-replay.ts). Hosts that only resume via session/load (Paseo's plugin ACP shim)
        // need this true; session/resume below serves hosts that prefer it.
        loadSession: true,
        sessionCapabilities: {
          // Unstable ACP resume: restore context without replaying messages.
          // Paseo prefers loadSession when present, else this path — so open
          // sessions are not blocked after an adapter restart.
          resume: {},
          // Lets hosts list/import sessions persisted by this adapter.
          list: {},
          close: {},
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
    this.clients.clear();
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const account = this.resolveAccount(initialAccountId(this.env));
    const { client, token } = this.ensureClient(params.cwd, account);
    const sessionId = `freebuff-${++this.sessionCounter}-${Date.now().toString(36)}`;
    const hostMcpServers = params.mcpServers;
    const modelId = initialModelId(this.env);
    const session: AdapterSession = {
      id: sessionId,
      cwd: params.cwd,
      modeId: DEFAULT_MODE_ID,
      modelId,
      accountId: account.id,
      accountName: accountDisplayName(account, this.env),
      confirmOpen: initialConfirmOpenMode(this.env),
      status: null,
      skills: [],
      client,
      token,
      runState: null,
      checkpoints: [],
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
    // F8: bounded — a slow quota server must not stall session open.
    await this.refreshStatusBounded(session);
    return {
      sessionId,
      modes: {
        availableModes: FREEBUFF_MODES,
        currentModeId: DEFAULT_MODE_ID,
      },
      models: modelState(modelId, session.status),
      configOptions: this.configOptionsFor(session),
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const session = await this.restoreSession(
      params.sessionId,
      params.cwd,
      params.mcpServers ?? [],
    );
    // Paseo keeps its timeline in memory and refills it from this replay after
    // a daemon restart. Awaited so the host has the full history before it
    // reads the load response. A failed delivery is logged, never swallowed
    // silently: dropped history looks like an empty chat to the user.
    let delivered = 0;
    let failed = 0;
    for (const update of runStateToReplayUpdates(session.runState)) {
      try {
        await this.conn.sessionUpdate({
          sessionId: session.id,
          update,
        } as unknown as SessionNotification);
        delivered += 1;
      } catch (error) {
        failed += 1;
        logWarn(
          `history replay to ${session.id} failed for update ${delivered + failed}: ${describeError(error)}`,
        );
      }
    }
    if (failed > 0) {
      logWarn(
        `history replay to ${session.id} delivered ${delivered}/${delivered + failed} updates; ` +
          "the restored RunState still carries the full context",
      );
    }
    this.emitContextUsage(session);
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
    this.emitContextUsage(session);
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
    const persisted = loadPersistedSession(sessionId, this.env);
    const account = this.resolveAccount(persisted?.accountId);
    const { client, token } = this.ensureClient(cwd, account);
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
      accountId: account.id,
      accountName: accountDisplayName(account, this.env),
      confirmOpen:
        persisted?.confirmOpen && isConfirmOpenMode(persisted.confirmOpen)
          ? persisted.confirmOpen
          : initialConfirmOpenMode(this.env),
      status: null,
      ...(persisted?.title ? { title: persisted.title } : {}),
      skills: [],
      client,
      token,
      runState: persisted?.runState ?? null,
      checkpoints: persisted?.checkpoints ?? [],
      busy: false,
      abortController: null,
      inflight: null,
      mcpServers: resolveRunMcpServers(hostMcpServers ?? [], sessionCwd),
      hostMcpServers,
    };
    this.sessions.set(sessionId, session);
    this.persist(session);
    this.scheduleCommandsPublish(session);
    // F8: bounded — a slow quota server must not stall session restore.
    await this.refreshStatusBounded(session);
    return session;
  }

  private persist(session: AdapterSession): void {
    savePersistedSession(
      {
        sessionId: session.id,
        cwd: session.cwd,
        modeId: session.modeId,
        modelId: session.modelId,
        confirmOpen: session.confirmOpen,
        accountId: session.accountId,
        ...(session.title ? { title: session.title } : {}),
        runState: session.runState,
        ...(session.checkpoints.length > 0 ? { checkpoints: session.checkpoints } : {}),
        updatedAt: new Date().toISOString(),
      },
      this.env,
    );
  }

  private sessionState(session: AdapterSession) {
    return {
      ...this.modeState(session.modeId),
      models: modelState(session.modelId, session.status),
      configOptions: this.configOptionsFor(session),
    };
  }

  private configOptionsFor(session: AdapterSession) {
    const accounts = listAccounts(this.env).map((account) => ({
      id: account.id,
      label:
        account.id === session.accountId
          ? session.accountName
          : accountDisplayName(account, this.env),
      status:
        account.id === session.accountId
          ? session.status
          : (this.accountStatuses.get(account.id) ?? null),
    }));
    return buildConfigOptions({
      accounts,
      currentAccountId: session.accountId,
      confirmOpen: session.confirmOpen,
      models: modelState(session.modelId, session.status),
    });
  }

  /** Re-read quota/prices; keeps the previous snapshot when the server is unreachable. */
  private async refreshStatus(session: AdapterSession): Promise<void> {
    const accounts = listAccounts(this.env);
    await Promise.all(
      accounts.map(async (account) => {
        const token =
          account.id === session.accountId
            ? session.token
            : credentialsForAccount(account, this.env)?.apiKey;
        if (!token) return;
        const status = await fetchAccountStatus(token);
        if (status) this.accountStatuses.set(account.id, status);
      }),
    );
    const current = this.accountStatuses.get(session.accountId);
    if (current) session.status = current;
  }

  /** Move a session to another registered account; the conversation state carries over. */
  private switchAccount(session: AdapterSession, accountId: string): void {
    if (session.busy) throw new Error("Cannot switch account while a turn is running.");
    const account = findAccount(accountId, this.env);
    if (!account) throw new Error(`Unknown account: ${accountId}`);
    const { client, token } = this.ensureClient(session.cwd, account);
    session.accountId = account.id;
    session.accountName = accountDisplayName(account, this.env);
    session.client = client;
    session.token = token;
    session.status = this.accountStatuses.get(account.id) ?? null;
    this.persist(session);
  }

  /** Push the current account/quota/switch state to the host (best-effort). */
  private publishConfigOptions(session: AdapterSession): void {
    void this.conn
      .sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: this.configOptionsFor(session),
        },
      } as unknown as SessionNotification)
      .catch(() => {
        // Best-effort, like every stream update.
      });
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session: ${params.sessionId}`);
    const value = String((params as { value: unknown }).value);
    switch (params.configId) {
      case MODEL_CONFIG_ID:
        await this.unstable_setSessionModel({ sessionId: params.sessionId, modelId: value });
        break;
      case CONFIRM_OPEN_CONFIG_ID:
        if (!isConfirmOpenMode(value)) throw new Error(`Unknown session-open mode: ${value}`);
        session.confirmOpen = value;
        this.persist(session);
        break;
      case ACCOUNT_CONFIG_ID:
        if (value !== session.accountId) this.switchAccount(session, value);
        // F8: bounded — keep the last known status on a slow server.
        await this.refreshStatusBounded(session);
        break;
      default:
        throw new Error(`Unknown config option: ${params.configId}`);
    }
    return { configOptions: this.configOptionsFor(session) };
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
    // A different model has a different window: recompute the fill.
    this.emitContextUsage(session);
    return {};
  }

  /** Host is done with the session: stop any turn and drop it from memory (state stays on disk). */
  async unstable_closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      await this.stopRunningTurn(session);
      this.persist(session);
      this.sessions.delete(params.sessionId);
    }
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

    // Checkpoint the pre-turn state so the host can rewind to this turn.
    // Ordinal = the ordinal this prompt WILL have (existing turns + 1); a
    // /clear before it resets the conversation, so count from the live state.
    session.checkpoints = recordCheckpoint({
      checkpoints: session.checkpoints,
      turn: countUserTurns(session.runState) + 1,
      promptText: rawText,
      runState: session.runState,
    });

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
      // immediately: only one runTurn may be
      // in flight across all sessions at once.
      const task = this.turnLane.then(async (): Promise<TurnResult> => {
        if (abortController.signal.aborted) {
          // Cancelled while queued: never start admission for a turn the
          // caller already gave up on.
          return { stopReason: "cancelled", runState: session.runState };
        }
        // F6: hard deadline for the running turn (admission + SDK run). A
        // hung call would otherwise wedge the process-wide lane forever.
        const disarmWatchdog = this.armTurnWatchdog(session.id, abortController);
        const emit = (update: Record<string, unknown> & { sessionUpdate: string }) => {
          void this.conn
            .sessionUpdate({ sessionId: session.id, update } as unknown as SessionNotification)
            .catch(() => {
              // Stream updates are best-effort; the prompt result carries the outcome.
            });
        };
        try {
          this.activeTurn = {
            cwd: session.cwd,
            signal: abortController.signal,
            sessionId: session.id,
          };
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
            confirmSessionOpen:
              session.confirmOpen === "auto"
                ? undefined
                : (info) => this.confirmSessionOpen(session.id, info),
            // Ending the shared seat can cut another agent's run: always ask.
            confirmModelSwitch: (info) => this.confirmModelSwitch(session.id, info),
            emit,
          });
        } finally {
          disarmWatchdog();
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
      session.runState = nextConversationState(
        session.runState,
        result.runState,
        result.stopReason,
      );
      this.adoptAdmittedModel(session, result.admittedModel);
      this.persist(session);
      this.emitContextUsage(session);
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
      // The turn may have spent Freebucks; refresh the quota line. F8: the
      // failure is swallowed and logged — never an unhandled rejection.
      void this.refreshStatus(session)
        .then(() => this.publishConfigOptions(session))
        .catch(ignoreStatusError);
    }
  }

  /** Abort the session's running turn (if any) and wait for it to unwind. */
  private async stopRunningTurn(session: AdapterSession): Promise<void> {
    while (session.busy) {
      session.abortController?.abort();
      await session.inflight;
    }
  }

  /**
   * F6: arm the per-turn hard watchdog. Returns a disarm function the caller
   * MUST run when the turn unwinds. A disabled timeout (0) arms nothing.
   */
  private armTurnWatchdog(sessionId: string, abortController: AbortController): () => void {
    const timeoutMs = resolveTurnTimeoutMs(this.env);
    if (timeoutMs <= 0) return () => undefined;
    let fired = false;
    const timer = setTimeout(() => {
      fired = true;
      this.fireTurnWatchdog(sessionId, abortController, timeoutMs);
    }, timeoutMs);
    return () => {
      if (!fired) clearTimeout(timer);
    };
  }

  /** F6: deadline hit — abort the turn, tell the host, let the lane drain. */
  private fireTurnWatchdog(
    sessionId: string,
    abortController: AbortController,
    timeoutMs: number,
  ): void {
    const seconds = Math.round(timeoutMs / 1000);
    const message =
      `Freebuff turn timed out after ${seconds}s (FREEBUFF_TURN_TIMEOUT_MS) and was stopped. ` +
      "The conversation state was kept — retry with a smaller prompt if this repeats.";
    logWarn(`turn watchdog fired for session ${sessionId} after ${seconds}s.`);
    abortController.abort();
    void this.conn
      .sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: message },
        },
      } as unknown as SessionNotification)
      .catch(() => {
        // The host may be gone already; the stderr log carries the signal.
      });
  }

  /**
   * F8: refreshStatus bounded by STATUS_REFRESH_TIMEOUT_MS so session open,
   * restore and account switches never stall on a slow server. On timeout the
   * last known snapshot simply stays in place.
   */
  private async refreshStatusBounded(session: AdapterSession): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), STATUS_REFRESH_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([
        this.refreshStatus(session).catch(ignoreStatusError),
        timeout,
      ]);
      if (outcome === "timeout") {
        logWarn(
          `quota refresh for session ${session.id} exceeded ${STATUS_REFRESH_TIMEOUT_MS}ms; ` +
            "keeping the last known status.",
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * F7: one idempotent shutdown — abort any running turn, best-effort close
   * every SDK client, drop in-memory state. Called from the process shutdown
   * hooks and available to hosts/embedders managing the agent directly.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownRan) return;
    this.shutdownRan = true;
    for (const session of this.sessions.values()) {
      session.abortController?.abort();
    }
    // Deliberately no seat release here: another Paseo agent may have taken
    // over the account's seat since this process opened it, and a DELETE
    // would end a session this process no longer owns. The seat expires on
    // its own after its hour, or is ended via the plugin's End session button.
    await this.closeAllClients();
    this.clients.clear();
    this.sessions.clear();
  }

  private async closeAllClients(): Promise<void> {
    for (const client of this.clients.values()) {
      await this.closeClient(client);
    }
  }

  /**
   * The current SDK exposes no explicit teardown, so dispose/close/destroy
   * are closed over duck-typed; when none exists there is nothing to release.
   */
  private async closeClient(client: CodebuffClient): Promise<void> {
    const candidate = client as unknown as Record<string, unknown>;
    const closerName = ["dispose", "close", "destroy"].find(
      (name) => typeof candidate[name] === "function",
    );
    if (!closerName) return;
    try {
      await (candidate[closerName] as () => unknown)();
    } catch (error) {
      logWarn(`closing a Codebuff client failed: ${describeError(error)}`);
    }
  }

  /** F7: SIGTERM/SIGINT and a closed stdin all funnel into shutdown(). */
  private installShutdownHooks(): void {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    process.once("SIGTERM", this.onShutdownSignal);
    process.once("SIGINT", this.onShutdownSignal);
    // Worker threads expose no stdin; degrade to the signal hooks only.
    if (process.stdin) {
      process.stdin.on("end", this.onStdinEnd);
    }
  }

  /**
   * Shut down, then re-raise the signal: registering the listener suppressed
   * the default termination for this delivery only, so the process still
   * dies once the clients are closed.
   */
  private readonly onShutdownSignal = (signal: NodeJS.Signals): void => {
    void this.shutdown().finally(() => {
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
    });
  };

  private readonly onStdinEnd = (): void => {
    void this.shutdown();
  };

  /** Tell the host how full the conversation context is (standard ACP `usage_update`). */
  private emitContextUsage(session: AdapterSession, cleared = false): void {
    const update = cleared
      ? clearedContextUsageUpdate(session.modelId)
      : contextUsageUpdate(session.runState, session.modelId);
    if (!update) return;
    void this.conn
      .sessionUpdate({ sessionId: session.id, update } as unknown as SessionNotification)
      .catch(() => {
        // Best-effort, like every stream update.
      });
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
        this.emitContextUsage(session, true);
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
      // Spends credit: hosts with auto-accept must still ask a person.
      _meta: REQUIRE_APPROVAL_META,
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

  /**
   * The account has one seat and it is held on another model (by another
   * agent or a Freebuff CLI). Keep it by default; switching ends it.
   */
  private async confirmModelSwitch(sessionId: string, info: ModelSwitchInfo): Promise<boolean> {
    const cost = info.priceFreebucks != null ? `${info.priceFreebucks} Freebucks` : "Freebucks";
    const response = await this.conn.requestPermission({
      sessionId,
      _meta: REQUIRE_APPROVAL_META,
      toolCall: {
        toolCallId: `freebuff-switch-${crypto.randomUUID()}`,
        title: "Switch the account's Freebuff model?",
        kind: "other",
        status: "pending",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text:
                `This account already has an open Freebuff session on ${info.currentModel} ` +
                `(one session per account, shared with other agents and CLIs). ` +
                `Switching to ${info.requestedModel} ends it, which can interrupt another agent, ` +
                `and opens a new one (${cost}, 1 hour).`,
            },
          },
        ],
      },
      options: [
        {
          optionId: "keep-session",
          name: `Keep ${info.currentModel} (no change)`,
          kind: "reject_once",
        },
        {
          optionId: "switch-model",
          name: `Switch to ${info.requestedModel} — ${cost}`,
          kind: "allow_once",
        },
      ],
    });
    return response.outcome.outcome === "selected" && response.outcome.optionId === "switch-model";
  }

  /**
   * Conversation rewind (owner directive 2026-09-26): restore the session to
   * the state BEFORE user turn `turn` (1-based ordinal of REAL prompts,
   * computed by the host bridge from its timeline). Drops the checkpoint tail,
   * persists, and replays the restored conversation so the host can replace
   * its timeline (the same contract `session/load` serves).
   * Conversation-only: the adapter owns no file-checkpoint primitive (same
   * scope as codex thread rollback).
   */
  async rewindToUserTurn(params: {
    sessionId: string;
    turn: number;
  }): Promise<{ replays: number; remainingTurns: number }> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown session: ${params.sessionId}`);
    if (session.busy) throw new Error("Cannot rewind while a turn is running.");

    const checkpoint = checkpointForRewind(session.checkpoints, session.runState, params.turn);
    if (!checkpoint) {
      throw new Error(`No rewind point for user turn ${params.turn}`);
    }

    session.runState = checkpoint.runState;
    session.checkpoints = checkpointsAfterRewind(session.checkpoints, params.turn);
    this.persist(session);

    // Replay the restored conversation: the host replaces its timeline from
    // these updates (identical to the session/load replay contract).
    let replays = 0;
    for (const update of runStateToReplayUpdates(session.runState)) {
      try {
        await this.conn.sessionUpdate({
          sessionId: session.id,
          update,
        } as unknown as SessionNotification);
        replays += 1;
      } catch (error) {
        logWarn(
          `rewind replay to ${session.id} failed at update ${replays + 1}: ${describeError(error)}`,
        );
        break;
      }
    }
    this.emitContextUsage(session);
    return { replays, remainingTurns: countUserTurns(session.runState) };
  }

  /**
   * ACP extension-method surface (owner rewind directive). Methods are
   * `freebuff:*`-prefixed per the ACP extensibility guidance; unknown methods
   * throw so the host sees a clean method-not-found instead of silence.
   */
  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case "freebuff/rewindToUserTurn": {
        const sessionId = String(params.sessionId ?? "");
        const turn = Number(params.turn);
        if (!sessionId || !Number.isInteger(turn) || turn < 1) {
          throw new Error("freebuff/rewindToUserTurn requires sessionId and a 1-based turn");
        }
        const result = await this.rewindToUserTurn({ sessionId, turn });
        return { replays: result.replays, remainingTurns: result.remainingTurns };
      }
      default:
        throw new Error(`Unknown freebuff extension method: ${method}`);
    }
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
