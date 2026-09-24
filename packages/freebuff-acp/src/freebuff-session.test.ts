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
