import type {
  PluginHookContext,
  PluginServerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import {
  buildChipData,
  configFacts,
  type ConfigFacts,
  type SnapshotControls,
} from "./server/ctx-capture.js";
import { CTX_INJECT_KIND, CTX_INJECT_ROW_ID, CTX_INJECT_VERSION } from "./shared/ctx-schema.js";

/**
 * Context-inject chip (C3).
 *
 * Records what context an agent was CONFIGURED with when its session opened, as
 * one replaceable row on the agent's chat timeline. Two captures are needed
 * because the hook API splits them: `agent.create` carries the session config
 * (systemPrompt, mcpServers) but no agent id — the daemon assigns that — while
 * `agent.session_open` carries the agent id but only `env`.
 *
 * Correlation therefore runs through a short-lived pending queue keyed by
 * provider+cwd, both of which the two hooks share. That is deliberately not the
 * plain FIFO some implementations use: `agent.created` ("creation finishes")
 * fires AFTER `agent.session_open`, so a create-then-created round trip leaves
 * the first session open with nothing bound and the chip permanently unknown.
 * Matching on facts both hooks agree on avoids that, and keeps concurrent
 * creations of different providers from stealing each other's config.
 *
 * Nothing here may block or throw on the session-open path: a failed chip is
 * cosmetic, a failed session open is not.
 */

/** Unbound create facts older than this are dropped rather than misattributed. */
const PENDING_TTL_MS = 60_000;

interface PendingFact {
  at: number;
  facts: ConfigFacts;
}

/** provider + cwd: the two identity fields both hooks expose. */
function pendingKey(provider: string, cwd: string): string {
  return `${provider}\u0000${cwd}`;
}

export default function contribute(server: PluginServerContext) {
  const pending = new Map<string, PendingFact[]>();
  /** Last facts we actually observed opening this agent's session, for refreshes. */
  const knownByAgent = new Map<string, ConfigFacts>();

  /** Oldest unexpired fact for this agent's bucket, or null when none is ours. */
  function takePending(provider: string, cwd: string): ConfigFacts | null {
    const bucket = pending.get(pendingKey(provider, cwd));
    if (!bucket) return null;
    const now = Date.now();
    while (bucket.length > 0) {
      const entry = bucket.shift()!;
      // Expired means the matching session open never arrived; dropping it keeps a
      // later, unrelated open from inheriting a stale config.
      if (now - entry.at <= PENDING_TTL_MS) return entry.facts;
    }
    pending.delete(pendingKey(provider, cwd));
    return null;
  }

  const disposers: Array<() => void> = [];

  // Stage 1: reduce the spawn config to facts while we are the only ones who
  // can see it. Display-only capture; the request is returned untouched.
  disposers.push(
    server.before("agent.create", ({ request }) => {
      const key = pendingKey(request.config.provider, request.config.cwd);
      const bucket = pending.get(key) ?? [];
      bucket.push({ at: Date.now(), facts: configFacts(request.config) });
      pending.set(key, bucket);
      return request;
    }),
  );

  // Stage 2: the session open is where an agentId exists and where the row is
  // worth emitting. Fire-and-forget: this hook must return immediately.
  disposers.push(
    server.before("agent.session_open", ({ request }, context) => {
      void appendChip(context, request, takePending(request.provider, request.cwd), knownByAgent);
      return request;
    }),
  );

  return () => {
    for (const dispose of disposers) dispose();
    disposers.length = 0;
    pending.clear();
    knownByAgent.clear();
  };
}

type SessionOpenRequest = PluginSessionOpenRequest;

/**
 * Emit the chip row. Never throws: every failure is logged and swallowed so a
 * cosmetic capture can never break a session open.
 */
async function appendChip(
  context: PluginHookContext,
  request: SessionOpenRequest,
  freshFacts: ConfigFacts | null,
  knownByAgent: Map<string, ConfigFacts>,
): Promise<void> {
  try {
    // A refresh re-opens the same session without running the create hook, so the
    // facts we saw when it was created still describe it. A resume or import is a
    // different session whose config we never observed, and stays unknown.
    const facts =
      freshFacts ??
      (request.reason === "refresh" ? (knownByAgent.get(request.agentId) ?? null) : null);
    if (freshFacts) knownByAgent.set(request.agentId, freshFacts);

    const data = buildChipData({
      facts,
      snapshot: readSnapshotControls(context, request.agentId),
      // A history/refetch open must not pay the config read on the hot path.
      paseoToolsInjected:
        request.purpose === "interactive"
          ? await readPaseoToolsInjected(context, request.provider)
          : null,
      reason: request.reason,
      capturedAt: new Date().toISOString(),
    });

    // Constant row id per agent: a later session open REPLACES the row instead of
    // stacking a new chip into the transcript on every resume.
    await context.paseo.agents.ref(request.agentId).timeline.append({
      type: "plugin",
      id: CTX_INJECT_ROW_ID,
      kind: CTX_INJECT_KIND,
      version: CTX_INJECT_VERSION,
      data,
    });
  } catch (error) {
    console.error("[ctx-inject] chip capture failed", request.agentId, error);
  }
}

/** Model/mode from the agent snapshot. Any failure yields nulls, never guesses. */
function readSnapshotControls(
  context: PluginHookContext,
  agentId: string,
): SnapshotControls | null {
  try {
    const agent = context.paseo.agents.ref(agentId).current();
    if (!agent) return null;
    return { model: agent.model ?? null, currentModeId: agent.currentModeId ?? null };
  } catch {
    return null;
  }
}

/**
 * Whether Paseo injects its own MCP tools for this provider, from daemon config
 * (`providers[provider].paseoTools.enabled`). An unset entry or a failed read is
 * unknown (null), which is not the same claim as "disabled".
 */
async function readPaseoToolsInjected(
  context: PluginHookContext,
  provider: string,
): Promise<boolean | null> {
  try {
    const { config } = await context.paseo.config.get();
    const providers = config.providers as
      | Record<string, { paseoTools?: { enabled?: boolean } }>
      | undefined;
    const enabled = providers?.[provider]?.paseoTools?.enabled;
    return typeof enabled === "boolean" ? enabled : null;
  } catch {
    return null;
  }
}
