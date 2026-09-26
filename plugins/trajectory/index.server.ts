import type { PluginServerContext } from "@getpaseo/plugin/server";
import { handleChanges, handleList } from "./server/rpc.js";
import { trajectoryChanges, trajectoryList } from "./shared/trajectory.js";
import { createWiring, openDefaultStore } from "./server/wiring.js";

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
      // Timeline replay: pass terminal tool items through the recorder with
      // the explicit turnId; dedupe absorbs repeats from the stream path.
      for (const item of event.timeline) {
        if (item.type === "tool_call") {
          wiring.recorder.timelineItem({ agentId: event.agent.id, turnId: event.turnId, item });
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
