import { describe, expect, test } from "vitest";

import type {
  AgentCapabilityFlags,
  AgentCloseOptions,
  AgentCloseOutcome,
  AgentPromptInput,
  AgentSession,
  AgentStreamEvent,
  AgentRuntimeInfo,
} from "./agent-sdk-types.js";
import { wrapSessionProvider } from "./provider-registry.js";

type OptionalAgentSessionMethodName = {
  [K in keyof AgentSession]-?: undefined extends AgentSession[K]
    ? NonNullable<AgentSession[K]> extends (...args: never[]) => unknown
      ? K
      : never
    : never;
}[keyof AgentSession];

const OPTIONAL_AGENT_SESSION_METHOD_NAMES = [
  "listCommands",
  "setModel",
  "setThinkingOption",
  "setFeature",
  "revertConversation",
  "revertFiles",
  "revertBoth",
  "tryHandleOutOfBand",
] as const satisfies readonly OptionalAgentSessionMethodName[];

type MissingOptionalAgentSessionMethod = Exclude<
  OptionalAgentSessionMethodName,
  (typeof OPTIONAL_AGENT_SESSION_METHOD_NAMES)[number]
>;

const _allOptionalAgentSessionMethodsAreCovered: MissingOptionalAgentSessionMethod extends never
  ? true
  : never = true;

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: true,
};

const RUNTIME_INFO: AgentRuntimeInfo = {
  provider: "claude",
  sessionId: "session-1",
};

class FakeSession implements AgentSession {
  readonly provider = "claude";
  readonly id = "session-1";
  readonly capabilities = CAPABILITIES;
  readonly features = [];
  readonly recordedCalls: string[] = [];

  async run() {
    this.recordedCalls.push("run");
    return { timeline: [] };
  }

  async startTurn() {
    this.recordedCalls.push("startTurn");
    return { turnId: "turn-1" };
  }

  subscribe(_callback: (event: AgentStreamEvent) => void) {
    this.recordedCalls.push("subscribe");
    return () => {};
  }

  async *streamHistory() {
    this.recordedCalls.push("streamHistory");
    yield* emptyHistory();
  }

  async getRuntimeInfo() {
    this.recordedCalls.push("getRuntimeInfo");
    return RUNTIME_INFO;
  }

  async getAvailableModes() {
    this.recordedCalls.push("getAvailableModes");
    return [];
  }

  async getCurrentMode() {
    this.recordedCalls.push("getCurrentMode");
    return null;
  }

  async setMode(_modeId: string) {
    this.recordedCalls.push("setMode");
  }

  getPendingPermissions() {
    this.recordedCalls.push("getPendingPermissions");
    return [];
  }

  async respondToPermission() {
    this.recordedCalls.push("respondToPermission");
  }

  describePersistence() {
    this.recordedCalls.push("describePersistence");
    return null;
  }

  async interrupt() {
    this.recordedCalls.push("interrupt");
  }

  async close() {
    this.recordedCalls.push("close");
  }

  async listCommands() {
    this.recordedCalls.push("listCommands");
    return [];
  }

  async setModel() {
    this.recordedCalls.push("setModel");
  }

  async setThinkingOption() {
    this.recordedCalls.push("setThinkingOption");
  }

  async setFeature() {
    this.recordedCalls.push("setFeature");
  }

  async revertConversation() {
    this.recordedCalls.push("revertConversation");
  }

  async revertFiles() {
    this.recordedCalls.push("revertFiles");
  }

  async revertBoth() {
    this.recordedCalls.push("revertBoth");
  }

  tryHandleOutOfBand(_prompt: AgentPromptInput) {
    this.recordedCalls.push("tryHandleOutOfBand");
    return {
      run: async () => {
        this.recordedCalls.push("tryHandleOutOfBand.run");
      },
    };
  }
}

async function* emptyHistory(): AsyncGenerator<AgentStreamEvent> {
  for (const event of [] as AgentStreamEvent[]) {
    yield event;
  }
}

describe("wrapSessionProvider", () => {
  test("forwards every optional AgentSession method", async () => {
    const session = new FakeSession();
    const wrapped = wrapSessionProvider("custom-claude", session);

    await wrapped.listCommands?.();
    await wrapped.setModel?.("sonnet");
    await wrapped.setThinkingOption?.("high");
    await wrapped.setFeature?.("feature-1", true);
    await wrapped.revertConversation?.({ messageId: "message-1" });
    await wrapped.revertFiles?.({ messageId: "message-1" });
    await wrapped.revertBoth?.({ messageId: "message-1" });
    const handler = wrapped.tryHandleOutOfBand?.("/compact");
    await handler?.run({ emit: () => {} });

    expect(session.recordedCalls).toEqual([
      "listCommands",
      "setModel",
      "setThinkingOption",
      "setFeature",
      "revertConversation",
      "revertFiles",
      "revertBoth",
      "tryHandleOutOfBand",
      "tryHandleOutOfBand.run",
    ]);
  });
});

/**
 * The close-reason propagation hop.
 *
 * `wrapSessionProvider` stands between `AgentManager.closeAgent` and the real
 * provider session for every provider that goes through `wrapClientProvider` —
 * i.e. any aliased/overridden provider (a `providerOverrides` entry with its
 * own `id`, or any provider with model overrides), where
 * `createResolvedProviderClient` takes the wrapping branch instead of handing
 * back the inner client unchanged.
 *
 * A wrapper that dropped the argument would fail SAFE and silently: the inner
 * session would see `reason: undefined`, `shouldDetachAgentProcess` would
 * return false for a `daemon-stop` close, and detach-on-stop would simply
 * never happen for that provider. Nothing would throw, no log line would look
 * wrong, and the whole suite would stay green — which is exactly why this hop
 * needs its own assertion on the value that actually arrived.
 */
describe("wrapSessionProvider close-reason propagation", () => {
  /** Records the options the inner session's `close` actually received. */
  class CloseRecordingSession extends FakeSession {
    readonly closeOptions: (AgentCloseOptions | undefined)[] = [];
    readonly closeOutcomes: (AgentCloseOutcome | void)[] = [];
    detachedOnReason: "user" | "daemon-stop" | undefined = "daemon-stop";

    override async close(options?: AgentCloseOptions): Promise<AgentCloseOutcome | void> {
      this.closeOptions.push(options);
      const detached = options?.reason === this.detachedOnReason;
      this.closeOutcomes.push({ detached });
      return { detached };
    }
  }

  test("a daemon-stop reason reaches the inner session through the wrapper", async () => {
    const session = new CloseRecordingSession();
    const wrapped = wrapSessionProvider("opencode-work", session);

    await wrapped.close({ reason: "daemon-stop" });

    expect(session.closeOptions).toEqual([{ reason: "daemon-stop" }]);
  });

  test("a user reason reaches the inner session through the wrapper", async () => {
    const session = new CloseRecordingSession();
    session.detachedOnReason = undefined;
    const wrapped = wrapSessionProvider("opencode-work", session);

    await wrapped.close({ reason: "user" });

    expect(session.closeOptions).toEqual([{ reason: "user" }]);
  });

  test("the wrapper returns the inner close outcome so detachment can reach AgentManager", async () => {
    // The other direction of the hop. Even a wrapper that forwarded `options`
    // but returned nothing would make every close look non-detached and strip
    // resumability from every legitimately-detached agent.
    const session = new CloseRecordingSession();
    const wrapped = wrapSessionProvider("opencode-work", session);

    await expect(wrapped.close({ reason: "daemon-stop" })).resolves.toEqual({ detached: true });
  });

  test("a wrapper close with no options reaches the inner session with no options", async () => {
    // Guards against a "helpful" wrapper that substitutes a default reason: a
    // close that forgot to declare its intent must stay a user close.
    const session = new CloseRecordingSession();
    const wrapped = wrapSessionProvider("opencode-work", session);

    await wrapped.close();

    expect(session.closeOptions).toEqual([undefined]);
  });
});
