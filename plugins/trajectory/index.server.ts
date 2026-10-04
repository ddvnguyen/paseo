import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleChanges, handleList, handleSubscribe } from "./server/rpc.js";
import { trajectoryChanges, trajectoryList, trajectorySubscribe } from "./shared/trajectory.js";
import { createWiring, openDefaultStore } from "./server/wiring.js";
import {
  contextKeyOf,
  hash12,
  PendingContextQueue,
  sampleDaemonAppend,
  type ConfigReadable,
} from "./server/injected-context.js";

/**
 * The turn an item belongs to, when the item says so itself.
 *
 * Producers stamp their own turn identity on replayed history; the fallback of
 * "whatever turn is ending" is what made replayed rows land in the wrong place.
 */
function turnIdentityOf(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return null;
  const record = item as Record<string, unknown>;
  for (const key of ["turnId", "turn_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export default function contribute(server: PluginServerContext) {
  let cleanup: (() => void) | undefined;

  const ready = (async () => {
    let store;
    try {
      store = openDefaultStore();
    } catch (error) {
      console.error("[trajectory] store open failed", error);
      return () => {};
    }
    const wiring = createWiring({ store });

    // Reference bug 2: the PaseoApi only exists inside hook/RPC contexts, so
    // every callback calls ensureAttached first; the first one attaches once.
    const withPaseo = (paseo: unknown): void => {
      wiring.ensureAttached(paseo as Parameters<typeof wiring.ensureAttached>[0]);
    };

    /**
     * Context staged by `before("agent.create")`, awaiting the agent it belongs
     * to. Two facts per create: the caller's own systemPrompt (the only prompt
     * a plugin ever sees on a hook) and, sampled from daemon config, the
     * instructions the daemon appends to every session. See
     * server/injected-context.ts for why the second one has to be sampled from
     * config and attributed by time window rather than by a hook.
     */
    const pendingContext = new PendingContextQueue();

    server.on("agent.turn_started", (event, context) => {
      withPaseo(context.paseo);
      wiring.recorder.turnStarted({
        agentId: event.agent.id,
        turnId: event.turnId,
        provider: event.agent.provider,
      });
    });

    server.on("agent.turn_ended", (event, context) => {
      withPaseo(context.paseo);
      // Timeline replay. `turn_ended` re-sends the agent's ENTIRE timeline, so
      // attributing every item to the CURRENT turn is what produced PROD's 2392
      // orphan tool/result rows — a replayed historical result landed in the
      // turn that happened to be ending. An item that carries its own turn
      // identity is therefore attributed to that turn; only items with none
      // fall back to the ending turn. Dedupe is durable (the store is consulted,
      // not just the in-memory set), so a replay after a re-attach cannot
      // duplicate rows it already wrote.
      for (const item of event.timeline) {
        if (item.type === "tool_call") {
          const itemTurnId = turnIdentityOf(item);
          wiring.recorder.timelineItem({
            agentId: event.agent.id,
            turnId: itemTurnId ?? event.turnId,
            item,
          });
        }
      }
      const kind = event.outcome.kind;
      let outcome: "completed" | "failed" | "canceled" = "completed";
      if (kind === "failed") outcome = "failed";
      else if (kind === "canceled") outcome = "canceled";
      wiring.recorder.turnEnded({
        agentId: event.agent.id,
        turnId: event.turnId,
        outcome,
        error: event.outcome.kind === "failed" ? event.outcome.error.message : null,
      });
    });

    server.on("agent.created", (event, context) => {
      withPaseo(context.paseo);
      for (const row of pendingContext.take({ key: contextKeyOf(event.agent) })) {
        wiring.recorder.systemPromptAttached({ agentId: event.agent.id, ...row });
      }
    });

    // Injected context, reduced to length and a 12-char sha256 prefix and
    // nothing else: the ledger is length-only by rule and d-893c722f28 sets the
    // hash-only precedent. No prompt text is ever written.
    server.before("agent.create", async (input, context) => {
      withPaseo(context.paseo);
      const prompt = input.request.config.systemPrompt;
      const caller =
        typeof prompt === "string" && prompt.length > 0
          ? { charsLength: prompt.length, hash12: hash12(prompt) }
          : null;
      // Read inside the create so this sample and the daemon's own injection
      // share one window. Neither step can throw: a failed read is a missing
      // cosmetic row, never a failed agent creation.
      const daemonAppend = await sampleDaemonAppend(context.paseo as ConfigReadable);
      pendingContext.stage({
        key: contextKeyOf(input.request.config),
        caller,
        daemonAppend,
      });
      return input.request;
    });

    // Read RPCs: every handler also calls ensureAttached first (idempotent),
    // so a UI opened before any hook fires still attaches the streams.
    server.handle(trajectoryList, async (input, context) => {
      withPaseo(context.paseo);
      return handleList(wiring.store)(input);
    });
    server.handle(trajectoryChanges, async (input, context) => {
      withPaseo(context.paseo);
      return handleChanges(wiring.store)(input);
    });
    server.handle(trajectorySubscribe, async (input, context) => {
      withPaseo(context.paseo);
      return handleSubscribe(wiring.store)(input);
    });

    cleanup = () => {
      void wiring.cleanup().catch((error) => {
        console.error("[trajectory] cleanup failed", error);
      });
    };
  })();

  ready.catch((error) => {
    console.error("[trajectory] init failed", error);
  });

  return () => {
    cleanup?.();
  };
}
