import { afterEach, describe, expect, it, vi } from "vitest";

import { admitFreebuffSession } from "./freebuff-session.js";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function routes(calls: string[]) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    calls.push(`${method} ${path}`);
    if (method === "GET") {
      return json(200, {
        status: "active",
        instanceId: "held-1",
        model: "z-ai/glm-5.3-flash",
        freebucks: { prices: { "mimo/mimo-v2.5": 10 }, daily: { remaining: 20 } },
      });
    }
    if (method === "DELETE") return json(200, { status: "ended" });
    return json(200, { status: "active", instanceId: "new-2", model: "mimo/mimo-v2.5" });
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("model switch on a held seat", () => {
  it("keeps the held seat and its model when the switch is declined", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", routes(calls));
    const result = await admitFreebuffSession({
      token: "t",
      model: "mimo/mimo-v2.5",
      confirmSwitch: async () => false,
    });
    expect(result).toMatchObject({ ok: true, reused: true, model: "z-ai/glm-5.3-flash" });
    expect(calls.some((call) => call.startsWith("DELETE") || call.startsWith("POST"))).toBe(false);
  });

  it("ends the held seat then opens the requested model when approved, without a second prompt", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", routes(calls));
    const confirmOpen = vi.fn(async () => true);
    const confirmSwitch = vi.fn(async () => true);
    const result = await admitFreebuffSession({
      token: "t",
      model: "mimo/mimo-v2.5",
      confirmOpen,
      confirmSwitch,
    });
    expect(result).toMatchObject({ ok: true, reused: false, instanceId: "new-2" });
    expect(confirmSwitch).toHaveBeenCalledWith(
      expect.objectContaining({
        currentModel: "z-ai/glm-5.3-flash",
        requestedModel: "mimo/mimo-v2.5",
        priceFreebucks: 10,
      }),
    );
    expect(confirmOpen).not.toHaveBeenCalled();
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["GET", "DELETE", "POST"]);
  });

  it("does not ask when the held seat already runs the requested model", async () => {
    vi.stubGlobal("fetch", routes([]));
    const confirmSwitch = vi.fn(async () => true);
    const result = await admitFreebuffSession({
      token: "t",
      model: "z-ai/glm-5.3-flash",
      confirmSwitch,
    });
    expect(result).toMatchObject({ ok: true, reused: true });
    expect(confirmSwitch).not.toHaveBeenCalled();
  });

  it("fails closed (keeps the seat) when the host cannot answer", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", routes(calls));
    const result = await admitFreebuffSession({
      token: "t",
      model: "mimo/mimo-v2.5",
      confirmSwitch: async () => {
        throw new Error("host gone");
      },
    });
    expect(result).toMatchObject({ ok: true, reused: true });
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  });
});

/**
 * Fetch mock that records every call ("METHOD path") and the signal it was
 * given, delegating the response to `handler`. F1/F3/F4 tests branch on the
 * recorded method so they can fail only the GET, only the POST, etc.
 */
function trackedFetch(handler: (init: RequestInit) => Promise<Response>) {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    const requestInit = init ?? {};
    calls.push(`${requestInit.method ?? "GET"} ${String(url).replace(/^https?:\/\/[^/]+/, "")}`);
    signals.push(requestInit.signal);
    return handler(requestInit);
  };
  return { calls, signals, fetchMock };
}

const timeoutError = () =>
  Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

describe("admission failure handling", () => {
  it("reports an unknown seat on a non-OK probe and does not POST without a confirm hook", async () => {
    const { calls, fetchMock } = trackedFetch(async (init) =>
      init.method === "GET" ? json(503, { error: "boom" }) : json(200, {}),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await admitFreebuffSession({ token: "t", model: "mimo/mimo-v2.5" });
    expect(result).toMatchObject({ ok: false, unknownSeat: true, message: expect.any(String) });
    expect(calls).toEqual(["GET /api/v1/freebuff/session"]);
  });

  it("asks the host with probeUnknown:true on a transport failure and reports unknownSeat when declined", async () => {
    const { calls, fetchMock } = trackedFetch(async () => {
      throw new Error("socket gone");
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirmOpen = vi.fn(async () => false);
    const result = await admitFreebuffSession({ token: "t", model: "mimo/mimo-v2.5", confirmOpen });
    expect(confirmOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        probeUnknown: true,
        message: expect.stringContaining("socket gone"),
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      unknownSeat: true,
      message: expect.stringContaining("socket gone"),
    });
    expect(calls).toEqual(["GET /api/v1/freebuff/session"]);
  });

  it("claims blindly after the host approves an unknown-seat probe", async () => {
    const { calls, fetchMock } = trackedFetch(async (init) => {
      if ((init.method ?? "GET") === "GET") throw new Error("socket gone");
      return json(200, { status: "active", instanceId: "new-2", model: "mimo/mimo-v2.5" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const confirmOpen = vi.fn(async () => true);
    const result = await admitFreebuffSession({ token: "t", model: "mimo/mimo-v2.5", confirmOpen });
    expect(confirmOpen).toHaveBeenCalledWith(expect.objectContaining({ probeUnknown: true }));
    expect(result).toMatchObject({ ok: true, reused: false, instanceId: "new-2" });
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["GET", "POST"]);
  });

  it("marks the response as lost when the admission POST times out", async () => {
    const { calls, fetchMock } = trackedFetch(async (init) => {
      if ((init.method ?? "GET") === "GET") return json(200, { status: "none" });
      throw timeoutError();
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await admitFreebuffSession({ token: "t", model: "mimo/mimo-v2.5" });
    expect(result).toMatchObject({
      ok: false,
      waitingRoom: true,
      responseLost: true,
      message: expect.stringContaining("timed out"),
    });
    expect(calls.map((call) => call.split(" ")[0])).toEqual(["GET", "POST"]);
  });

  it("reports cancelled, not refusal, when the caller aborts during the POST", async () => {
    const { fetchMock } = trackedFetch(async (init) => {
      if ((init.method ?? "GET") === "GET") return json(200, { status: "none" });
      throw new DOMException("This operation was aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    const result = await admitFreebuffSession({
      token: "t",
      model: "mimo/mimo-v2.5",
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, cancelled: true });
  });

  it("passes an abort signal on every admission fetch", async () => {
    const { signals, fetchMock } = trackedFetch(async (init) => {
      const method = init.method ?? "GET";
      if (method === "DELETE") return json(200, { status: "ended" });
      if (method === "GET")
        return json(200, {
          status: "active",
          instanceId: "held-1",
          model: "z-ai/glm-5.3-flash",
        });
      return json(200, { status: "active", instanceId: "new-2", model: "mimo/mimo-v2.5" });
    });
    vi.stubGlobal("fetch", fetchMock);
    // Switch path exercises GET + DELETE + POST; the second run reuses via GET.
    await admitFreebuffSession({
      token: "t",
      model: "mimo/mimo-v2.5",
      confirmOpen: async () => true,
      confirmSwitch: async () => true,
    });
    await admitFreebuffSession({ token: "t", model: "mimo/mimo-v2.5" });
    expect(signals.length).toBeGreaterThanOrEqual(4);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });
});
