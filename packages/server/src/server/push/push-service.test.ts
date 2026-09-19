import type pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { PushService } from "./push-service.js";

interface LoggedCall {
  obj: Record<string, unknown>;
  msg: string;
}

function createLogger() {
  const errors: LoggedCall[] = [];
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (obj: Record<string, unknown>, msg: string) => {
      errors.push({ obj, msg });
    },
  };
  return { logger: logger as unknown as pino.Logger, errors };
}

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Server Error",
    json: async () => body,
  } as unknown as Response;
}

// Flush microtasks until cond() holds; no wall-clock timers.
async function flushUntil(cond: () => boolean, maxTurns = 200): Promise<void> {
  for (let i = 0; i < maxTurns; i++) {
    if (cond()) return;
    await Promise.resolve();
  }
  throw new Error("condition not met after microtask flush");
}

describe("PushService receipts", () => {
  test("MismatchSenderId receipt is logged per token and token is kept", async () => {
    const { logger, errors } = createLogger();
    const revoked: string[] = [];
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      if (url.endsWith("/push/send")) {
        return jsonResponse({
          data: [{ status: "ok", id: "receipt-1" }],
        });
      }
      return jsonResponse({
        data: {
          "receipt-1": {
            status: "error",
            message: "Mismatched sender",
            details: { error: "MismatchSenderId" },
          },
        },
      });
    });
    let scheduled: (() => void) | undefined;
    const service = new PushService(logger, (token) => revoked.push(token), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      schedule: (callback) => {
        scheduled = callback;
      },
      receiptDelayMs: 1,
    });

    await service.sendPush(["ExponentPushToken[fork]"], { title: "t", body: "b" });
    expect(scheduled).toBeDefined();
    scheduled?.();

    await flushUntil(() => calls.some((call) => call.url.endsWith("/push/getReceipts")));
    await flushUntil(() => errors.some((entry) => entry.msg === "Push delivery failed"));

    const delivery = errors.find((entry) => entry.msg === "Push delivery failed");
    expect(delivery?.obj).toMatchObject({
      token: "ExponentPushToken[fork]",
      receiptId: "receipt-1",
      details: { error: "MismatchSenderId" },
    });
    expect(revoked).toEqual([]);
    expect(calls[1].body).toEqual({ ids: ["receipt-1"] });
  });

  test("DeviceNotRegistered receipt revokes the token", async () => {
    const { logger, errors } = createLogger();
    const revoked: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/push/send")) {
        return jsonResponse({ data: [{ status: "ok", id: "receipt-9" }] });
      }
      return jsonResponse({
        data: { "receipt-9": { status: "error", details: { error: "DeviceNotRegistered" } } },
      });
    });
    let scheduled: (() => void) | undefined;
    const service = new PushService(logger, (token) => revoked.push(token), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      schedule: (callback) => {
        scheduled = callback;
      },
      receiptDelayMs: 1,
    });

    await service.sendPush(["ExponentPushToken[dead]"], { title: "t", body: "b" });
    scheduled?.();
    await flushUntil(() => revoked.length === 1);
    expect(revoked).toEqual(["ExponentPushToken[dead]"]);
    expect(errors.some((entry) => entry.msg === "Push delivery failed")).toBe(true);
  });

  test("ticket error does not schedule a receipt check", async () => {
    const { logger } = createLogger();
    const revoked: string[] = [];
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: [{ status: "error", message: "bad", details: { error: "DeviceNotRegistered" } }],
      }),
    );
    let scheduled = 0;
    const service = new PushService(logger, (token) => revoked.push(token), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      schedule: () => {
        scheduled += 1;
      },
      receiptDelayMs: 1,
    });

    await service.sendPush(["ExponentPushToken[gone]"], { title: "t", body: "b" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(scheduled).toBe(0);
    expect(revoked).toEqual(["ExponentPushToken[gone]"]);
  });
});
