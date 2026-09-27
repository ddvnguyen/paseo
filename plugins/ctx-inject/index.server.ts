import type {
  PluginHookContext,
  PluginLifecycleEvents,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import { ChipQueue, type ChipSink } from "./server/chip-queue.js";
import { buildChipData } from "./server/ctx-capture.js";
import { CTX_INJECT_KIND, CTX_INJECT_ROW_ID, CTX_INJECT_VERSION } from "./shared/ctx-schema.js";

/**
 * Context-inject chip (C3).
 *
 * Records what context an agent was CONFIGURED with when its session opened, as
 * one replaceable row on the agent's chat timeline.
 *
 * The hook API splits the capture in two: `agent.create` carries the session
 * config (systemPrompt, mcpServers) but no agent id — the daemon assigns that —
 * while `agent.session_open` carries the agent id but only `env`. Correlation
 * runs through a short-lived queue keyed by provider+cwd, the identity fields
 * both hooks expose. That is deliberately not a plain FIFO: `agent.created`
 * ("creation finishes") fires AFTER `agent.session_open`, so binding facts at
 * agent.created leaves the first session open with nothing to show.
 *
 * The row is not WRITTEN at session-open time, because that hook is pre-commit:
 * QC round 8 measured the append failing with "Unknown agent" ~770ms before the
 * daemon logged "Created agent". See server/chip-queue.ts for why that is an
 * event-driven flush rather than a retry budget.
 *
 * Nothing here may block or throw on a hook path: a missing chip row is
 * cosmetic, a failed session open is not. Failures are logged loudly, never
 * swallowed.
 */
export default function contribute(server: PluginServerContext) {
  const queue = new ChipQueue();
  let paseoApi: PluginHookContext["paseo"] | undefined;

  /** The PaseoApi only exists inside hook contexts; borrow it from the first. */
  const withPaseo = (context: PluginHookContext): void => {
    paseoApi ??= context.paseo;
  };

  const sink = (context: PluginHookContext): ChipSink => {
    const api = (): PaseoApi => {
      const resolved = context.paseo ?? paseoApi;
      if (!resolved) throw new Error("no PaseoApi available for the ctx-inject chip");
      return resolved;
    };
    return {
      probe: async (staged) => {
        // Whether the agent is live yet, and its controls if so. Read here rather
        // than at session-open, where a create is not yet committed and a resume
        // may be in the store but not loaded.
        const current = readCurrentAgent(api(), staged.agentId);
        if (!current) return { live: false, controls: null };
        return {
          live: true,
          controls: { model: current.model ?? null, currentModeId: current.currentModeId ?? null },
        };
      },
      buildData: async (staged, controls) => {
        return buildChipData({
          facts: staged.facts,
          // Configured model/mode win; the live snapshot is the fallback for a
          // session that never ran the create hook.
          snapshot: controls,
          // A history/refetch open must not pay the config read on the hot path.
          paseoToolsInjected:
            staged.purpose === "interactive"
              ? await readPaseoToolsInjected(api(), staged.provider)
              : null,
          reason: staged.reason,
          capturedAt: new Date().toISOString(),
        });
      },
      append: async (agentId, data) => {
        // Constant row id per agent: a later session open REPLACES the row instead of
        // stacking a new chip into the transcript on every resume.
        await api().agents.ref(agentId).timeline.append({
          type: "plugin",
          id: CTX_INJECT_ROW_ID,
          kind: CTX_INJECT_KIND,
          version: CTX_INJECT_VERSION,
          data,
        });
      },
      onError: (agentId, stage, error) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[ctx-inject] chip ${stage} failed for ${agentId}: ${detail}`);
      },
    };
  };

  const disposers: Array<() => void> = [];

  // Stage 1: reduce the spawn config while we are the only ones who can see it.
  // Display-only capture; the request is returned untouched.
  disposers.push(
    server.before("agent.create", ({ request }) => {
      queue.captureCreate(request.config.provider, request.config.cwd, request.config);
      return request;
    }),
  );

  // Stage 2a: session open knows the agent id, but for a create the agent is not
  // committed yet, so the row is parked rather than written.
  disposers.push(
    server.before("agent.session_open", ({ request }, context) => {
      withPaseo(context);
      void queue.handleSessionOpen(request, sink(context));
      return request;
    }),
  );

  // Stage 2b: the post-commit signal. By now the agent exists in agent-manager,
  // which is exactly what the r8 append needed.
  disposers.push(
    server.on("agent.created", (event: PluginLifecycleEvents["agent.created"], context) => {
      withPaseo(context);
      void queue.handleAgentCreated(event.agent.id, sink(context));
    }),
  );

  return () => {
    for (const dispose of disposers) dispose();
    disposers.length = 0;
    queue.clear();
  };
}

type PaseoApi = PluginHookContext["paseo"];

/** The subset of the agent record the chip reads. */
interface AgentRecord {
  model?: string | null;
  currentModeId?: string | null;
}

/**
 * The agent's current record, or null when it is not in agent-manager yet.
 * Any read failure is treated as "not available" so the queue retries instead of
 * writing a row full of em dashes from a premature read.
 */
function readCurrentAgent(api: PaseoApi, agentId: string): AgentRecord | null {
  try {
    return api.agents.ref(agentId).current() ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether Paseo injects its own MCP tools for this provider, from daemon config
 * (`providers[provider].paseoTools.enabled`). An unset entry or a failed read is
 * unknown (null), which is not the same claim as "disabled".
 */
async function readPaseoToolsInjected(api: PaseoApi, provider: string): Promise<boolean | null> {
  try {
    const { config } = await api.config.get();
    const providers = config.providers as
      | Record<string, { paseoTools?: { enabled?: boolean } }>
      | undefined;
    const enabled = providers?.[provider]?.paseoTools?.enabled;
    return typeof enabled === "boolean" ? enabled : null;
  } catch {
    return null;
  }
}
