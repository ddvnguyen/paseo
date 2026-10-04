import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runTurn } from "./turn.js";

/** Resolve a fetch() input (string | URL | Request) to a string href. */
function hrefOf(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.href;
  return String((url as Request).url ?? url);
}

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

let postCount = 0;

// Hermetic HTTP default: POST /session/admission → a fresh active seat per
// POST; GET /session → none (the seat probe) unless a test overrides it.
function installDefaultFetch(): void {
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    if (hrefOf(url).includes("/session/admission")) {
      postCount += 1;
      return new Response(
        JSON.stringify({
          status: "active",
          instanceId: `inst-${postCount}`,
          model: "z-ai/glm-5.3-flash",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ status: "none" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => {
  postCount = 0;
  installDefaultFetch();
});

afterEach(() => {
  delete process.env.FREEBUFF_SEAT_LIFETIME_MS;
  vi.useRealTimers();
  installDefaultFetch();
});

/** Collect the session updates runTurn emits. */
function makeEmit() {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    emit: (update: Record<string, unknown> & { sessionUpdate: string }) => {
      updates.push(update);
    },
  };
}

function chunkTexts(updates: Array<Record<string, unknown>>): string[] {
  return updates
    .filter((update) => update.sessionUpdate === "agent_message_chunk")
    .map((update) => (update.content as { text?: string } | undefined)?.text ?? "");
}

/** Client whose runs answer from `outcomes` in order; the last one repeats. */
function scriptedClient(
  outcomes: Array<Record<string, unknown> | (() => Promise<Record<string, unknown>>)>,
) {
  let call = 0;
  return {
    run: vi.fn(async () => {
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      return typeof outcome === "function" ? outcome() : outcome;
    }),
  };
}

function gateError(code: string, statusCode: number): Record<string, unknown> {
  return {
    sessionState: { ran: 1 },
    output: {
      type: "error",
      message: `Agent run error: {"error":"${code}","statusCode":${statusCode},"message":"gate"}`,
    },
  };
}

async function runBasicTurn(
  client: ReturnType<typeof scriptedClient>,
  confirmSessionOpen?: (info: unknown) => Promise<boolean>,
) {
  const { emit, updates } = makeEmit();
  const result = await runTurn({
    client: client as unknown as Parameters<typeof runTurn>[0]["client"],
    cwd: "/tmp",
    prompt: "hi",
    previousRun: null,
    signal: new AbortController().signal,
    token: "k",
    emit,
    ...(confirmSessionOpen ? { confirmSessionOpen: confirmSessionOpen as never } : {}),
  });
  return { result, updates };
}

describe("runTurn seat-expiry warning (Task B)", () => {
  it("warns once at lifetime-180s of a POST-claimed seat, not on the next turn", async () => {
    process.env.FREEBUFF_SEAT_LIFETIME_MS = "3600000";
    vi.useFakeTimers();
    vi.setSystemTime(0);

    let releaseRun: (value: Record<string, unknown>) => void = () => undefined;
    const client = {
      run: vi.fn(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            releaseRun = resolve;
          }),
      ),
    };
    const { emit, updates } = makeEmit();
    const pending = runTurn({
      client: client as unknown as Parameters<typeof runTurn>[0]["client"],
      cwd: "/tmp",
      prompt: "hi",
      previousRun: null,
      signal: new AbortController().signal,
      token: "k",
      emit,
    });

    // The seat was POST-claimed (openedAt = 0): the warning is due at 3420s.
    await vi.waitFor(() => expect(client.run).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(3_419_000);
    expect(chunkTexts(updates).filter((text) => text.includes("will close in 180s"))).toHaveLength(
      0,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const warnings = chunkTexts(updates).filter((text) => text.includes("will close in 180s"));
    expect(warnings).toHaveLength(1);

    releaseRun({ sessionState: { marker: 1 }, output: { type: "success" } });
    const result = await pending;
    expect(result.stopReason).toBe("end_turn");
    expect(postCount).toBe(1);

    // Second turn reuses the parked seat (fresh registry lookup): the warning
    // stays once-per-seat-window.
    const { updates: updates2, emit: emit2 } = makeEmit();
    const client2 = scriptedClient([{ sessionState: { marker: 2 }, output: { type: "success" } }]);
    await runTurn({
      client: client2 as unknown as Parameters<typeof runTurn>[0]["client"],
      cwd: "/tmp",
      prompt: "hi again",
      previousRun: null,
      signal: new AbortController().signal,
      token: "k",
      emit: emit2,
    });
    expect(chunkTexts(updates2).filter((text) => text.includes("will close in 180s"))).toHaveLength(
      0,
    );
  });

  it("never warns for a reused seat whose age is unknown", async () => {
    // Probe GET /session returns a live seat the adapter did not open itself.
    fetchMock.mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      if (((init?.method as string | undefined) ?? "GET").toUpperCase() === "GET") {
        return new Response(
          JSON.stringify({
            status: "active",
            instanceId: "inst-open",
            model: "z-ai/glm-5.3-flash",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      postCount += 1;
      return new Response(
        JSON.stringify({ status: "active", instanceId: "inst-open", model: "z-ai/glm-5.3-flash" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = scriptedClient([{ sessionState: { marker: 1 }, output: { type: "success" } }]);
    const { result, updates } = await runBasicTurn(client);
    expect(result.stopReason).toBe("end_turn");
    expect(chunkTexts(updates).some((text) => text.includes("will close in"))).toBe(false);
  });

  it("warns immediately when adoption happens inside the final 180s window", async () => {
    // 2-minute lifetime: the warning point (lifetime-180s) is already past
    // when the seat is claimed, but the seat is not dead yet.
    process.env.FREEBUFF_SEAT_LIFETIME_MS = "120000";
    const client = scriptedClient([{ sessionState: { marker: 1 }, output: { type: "success" } }]);
    const { result, updates } = await runBasicTurn(client);
    expect(result.stopReason).toBe("end_turn");
    expect(chunkTexts(updates).filter((text) => text.includes("will close in 180s"))).toHaveLength(
      1,
    );
  });
});

describe("runTurn one-time auto-renew (Task B)", () => {
  it("re-admits on a session-end gate WITHOUT asking, exactly once", async () => {
    const confirmSessionOpen = vi.fn(async () => true);
    const client = scriptedClient([
      gateError("session_expired", 410),
      { sessionState: { marker: 2 }, output: { type: "success" } },
    ]);
    const { result, updates } = await runBasicTurn(client, confirmSessionOpen);

    expect(result.stopReason).toBe("end_turn");
    expect(client.run).toHaveBeenCalledTimes(2);
    // The confirm hook was consulted for the INITIAL open only — the renewal
    // bypassed it (owner-approved one-time auto-renew).
    expect(confirmSessionOpen).toHaveBeenCalledTimes(1);
    expect(postCount).toBe(2);
    expect(chunkTexts(updates).join("\n")).toContain("auto-renewed the free session (one-time)");
  });

  it("never auto-renews twice: a second gate failure reports refusal without a third run", async () => {
    const confirmSessionOpen = vi.fn(async () => true);
    const gate = gateError("session_expired", 410);
    const client = scriptedClient([gate, gate]);
    const { result, updates } = await runBasicTurn(client, confirmSessionOpen);

    expect(result.stopReason).toBe("refusal");
    expect(client.run).toHaveBeenCalledTimes(2);
    // Two admissions total (initial + the one renewal); no third POST.
    expect(postCount).toBe(2);
    expect(chunkTexts(updates).join("\n")).toContain("Freebuff run failed");
  });

  it("renews with the SAME conversation state (previousRun carried into the retry)", async () => {
    const previousRun = { sessionState: { marker: 7 }, output: { type: "lastMessage", value: [] } };
    const { emit } = makeEmit();
    const promptsAndStates: Array<{ prompt?: string; previousRun?: unknown }> = [];
    const client = {
      run: vi.fn(async (options: Record<string, unknown>) => {
        promptsAndStates.push({
          prompt: options.prompt as string,
          previousRun: options.previousRun,
        });
        if (promptsAndStates.length === 1) return gateError("session_superseded", 409);
        return { sessionState: { marker: 8 }, output: { type: "success" } };
      }),
    };
    const result = await runTurn({
      client: client as unknown as Parameters<typeof runTurn>[0]["client"],
      cwd: "/tmp",
      prompt: "continue the work",
      previousRun: previousRun as never,
      signal: new AbortController().signal,
      token: "k",
      emit,
    });
    expect(result.stopReason).toBe("end_turn");
    expect(promptsAndStates).toHaveLength(2);
    expect(promptsAndStates[1]?.prompt).toBe("continue the work");
    expect(promptsAndStates[1]?.previousRun).toEqual(previousRun);
  });
});
