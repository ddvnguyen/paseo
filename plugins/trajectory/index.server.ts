import { createHash } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleChanges, handleList, handleSubscribe } from "./server/rpc.js";
import { trajectoryChanges, trajectoryList, trajectorySubscribe } from "./shared/trajectory.js";
import { createWiring, openDefaultStore } from "./server/wiring.js";

/** sha256 as lowercase hex, from the builtin so the plugin stays dependency-free. */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

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
     * Pending caller system prompts, awaiting the agent they belong to.
     *
     * `before("agent.create")` is the ONLY place a caller systemPrompt reaches a
     * plugin, and it carries no agent id — the agent does not exist yet.
     * `agent.created` carries the id but not the config. The daemon exposes no
     * request id on either hook, so the two are matched on
     * provider + cwd + title, with an oldest-first fallback for the case where
     * they disagree. The `correlated` field records which path was taken, so a
     * row is never presented as a certain match when it was a fallback.
     */
    const pendingSystemPrompts: Array<{ key: string; charsLength: number; hash12: string }> = [];
    const systemPromptKey = (parts: {
      provider: string;
      cwd: string;
      title?: string | null;
    }): string => `${parts.provider}\u0000${parts.cwd}\u0000${parts.title ?? ""}`;

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
      const key = systemPromptKey(event.agent);
      const exact = pendingSystemPrompts.findIndex((entry) => entry.key === key);
      const index = exact === -1 ? 0 : exact;
      if (pendingSystemPrompts.length === 0) return;
      const [pending] = pendingSystemPrompts.splice(index, 1);
      if (pending === undefined) return;
      wiring.recorder.systemPromptAttached({
        agentId: event.agent.id,
        charsLength: pending.charsLength,
        hash12: pending.hash12,
        correlated: exact === -1 ? "fifo" : "config",
      });
    });

    // The caller system prompt. Only ever its LENGTH and a 12-char sha256
    // prefix: the ledger is length-only by rule and d-893c722f28 sets the
    // hash-only precedent. The prompt text itself is never written.
    server.before("agent.create", (input, context) => {
      withPaseo(context.paseo);
      const prompt = input.request.config.systemPrompt;
      if (typeof prompt !== "string" || prompt.length === 0) return;
      pendingSystemPrompts.push({
        key: systemPromptKey(input.request.config),
        charsLength: prompt.length,
        hash12: sha256Hex(prompt).slice(0, 12),
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
