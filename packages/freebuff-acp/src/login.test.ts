import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { accountsFilePath } from "./accounts.js";
import { cancelLogin, pollLogin, startLogin } from "./login.js";

let stateDir = "";

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-acp-login-"));
});

afterEach(() => {
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    stateDir = "";
  }
  vi.unstubAllGlobals();
});

function env(): NodeJS.ProcessEnv {
  return {
    FREEBUFF_ACP_CONFIG_DIR: stateDir,
    FREEBUFF_ACP_ACCOUNTS_FILE: path.join(stateDir, "accounts.json"),
  };
}

function configDirFor(id: string): string {
  return path.join(stateDir, "accounts", id);
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Call {
  method: string;
  url: URL;
  body?: unknown;
}

/** Fake fetch capturing calls; `statusHandler` answers each status GET. */
function fakeFetch(
  calls: Call[],
  statusHandler: (call: Call) => Response = () => json(401, { error: "not redeemed" }),
): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = String(input);
    const url = new URL(rawUrl);
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: Call = { method: init?.method ?? "GET", url, body };
    calls.push(call);
    if (call.method === "GET" && url.pathname === "/api/auth/cli/status") {
      return statusHandler(call);
    }
    if (call.method === "POST" && url.pathname === "/api/auth/cli/code") {
      return json(200, {
        loginUrl: "https://www.codebuff.com/login?code=abc123",
        fingerprintHash: "hash-1",
        expiresAt: "2030-01-01T00:00:00.000Z",
      });
    }
    return json(404, { error: "unexpected call" });
  };
}

const SUCCESS_USER = {
  id: "user-1",
  name: "Test User",
  email: "user@example.com",
  authToken: "secret-token-value",
};

/** One status GET that answers success. */
function successStatusHandler(): Response {
  return json(200, { user: SUCCESS_USER });
}

describe("startLogin", () => {
  it("creates the config dir, persists fingerprint, posts the code, writes pending 0600, echoes expiresAt", async () => {
    const calls: Call[] = [];
    const result = await startLogin("work", env(), fakeFetch(calls), "Work");

    // Config dir created under the accounts base.
    expect(fs.statSync(configDirFor("work")).isDirectory()).toBe(true);
    // Random per-account fingerprintId persisted in the config dir.
    const stored = fs
      .readFileSync(path.join(configDirFor("work"), "fingerprint-id"), "utf8")
      .trim();
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    // The POST carried the same fingerprintId.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/api/auth/cli/code");
    expect(calls[0].body).toEqual({ fingerprintId: stored });
    // Pending handshake file, mode 0600, echoing the server's expiresAt.
    const pendingPath = path.join(configDirFor("work"), ".login-pending.json");
    expect(fs.statSync(pendingPath).mode & 0o777).toBe(0o600);
    const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
    expect(pending).toMatchObject({
      fingerprintId: stored,
      fingerprintHash: "hash-1",
      expiresAt: "2030-01-01T00:00:00.000Z",
      label: "Work",
    });
    // Output carries the login URL and the server's expiry, nothing else.
    expect(result.loginUrl).toContain("https://");
    expect(result.expiresAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("restarts with a fresh link when called again for the same id", async () => {
    const calls: Call[] = [];
    const fetchFn = fakeFetch(calls);
    const first = await startLogin("work", env(), fetchFn, "Work");
    const firstPending = fs.readFileSync(
      path.join(configDirFor("work"), ".login-pending.json"),
      "utf8",
    );

    const second = await startLogin("work", env(), fetchFn, "Work");

    expect(calls).toHaveLength(2);
    expect(second.loginUrl).toBe(first.loginUrl);
    // The fingerprintId is regenerated per attempt (fresh device identity).
    const firstId = JSON.parse(firstPending).fingerprintId;
    const secondPending = JSON.parse(
      fs.readFileSync(path.join(configDirFor("work"), ".login-pending.json"), "utf8"),
    );
    expect(secondPending.fingerprintId).not.toBe(firstId);
  });

  it("rejects an invalid id without touching the network or disk", async () => {
    const calls: Call[] = [];
    for (const bad of ["default", "Bad Id", "", "UPPER", "x".repeat(40)]) {
      await expect(startLogin(bad, env(), fakeFetch(calls))).rejects.toThrow(/Invalid account id/i);
    }
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(configDirFor("default"))).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });
});

describe("pollLogin", () => {
  it("answers none without a login in progress", async () => {
    const calls: Call[] = [];
    expect(await pollLogin("work", env(), fakeFetch(calls))).toEqual({ status: "none" });
    expect(calls).toHaveLength(0);
  });

  it("answers pending on 401 before redemption", async () => {
    const calls: Call[] = [];
    await startLogin("work", env(), fakeFetch(calls));
    const statusCalls: Call[] = [];
    const result = await pollLogin("work", env(), fakeFetch(statusCalls));

    expect(result).toEqual({ status: "pending" });
    expect(statusCalls).toHaveLength(1);
    const call = statusCalls[0];
    expect(call.method).toBe("GET");
    expect(call.url.pathname).toBe("/api/auth/cli/status");
    const pending = JSON.parse(
      fs.readFileSync(path.join(configDirFor("work"), ".login-pending.json"), "utf8"),
    );
    expect(call.url.searchParams.get("fingerprintId")).toBe(pending.fingerprintId);
    expect(call.url.searchParams.get("fingerprintHash")).toBe(pending.fingerprintHash);
    expect(call.url.searchParams.get("expiresAt")).toBe(pending.expiresAt);
    expect(fs.existsSync(path.join(configDirFor("work"), ".login-pending.json"))).toBe(true);
  });

  it("handles the live server shape: numeric expiresAt echoed as its decimal string", async () => {
    const liveShape: typeof fetch = async () =>
      json(200, {
        fingerprintId: "server-echo",
        fingerprintHash: "hash-live",
        loginUrl: "https://www.codebuff.com/login?auth_code=abc",
        expiresAt: 1_790_000_000_000,
        expiresInMs: 3_600_000,
      });
    const started = await startLogin("work", env(), liveShape);
    expect(started.expiresAt).toBe("1790000000000");

    const statusCalls: Call[] = [];
    const result = await pollLogin("work", env(), fakeFetch(statusCalls));
    expect(result).toEqual({ status: "pending" });
    expect(statusCalls[0].url.searchParams.get("expiresAt")).toBe("1790000000000");
  });

  it("judges expiry by expiresInMs on the local clock, ignoring a skewed server instant", async () => {
    // Server instant is far in the past (local clock "fast"), but the code is
    // valid for another hour: it must still be polled, not reported expired.
    const skewed: typeof fetch = async () =>
      json(200, {
        fingerprintHash: "hash-skew",
        loginUrl: "https://www.codebuff.com/login?auth_code=abc",
        expiresAt: 946_684_800_000,
        expiresInMs: 3_600_000,
      });
    await startLogin("work", env(), skewed);

    const statusCalls: Call[] = [];
    const result = await pollLogin("work", env(), fakeFetch(statusCalls));
    expect(result).toEqual({ status: "pending" });
    expect(statusCalls).toHaveLength(1);
  });

  it("rejects a login-code response without a fingerprint hash", async () => {
    const noHash: typeof fetch = async () =>
      json(200, { loginUrl: "https://x/y", expiresAt: 1_790_000_000_000 });
    await expect(startLogin("work", env(), noHash)).rejects.toThrow(/fingerprint hash/);
  });

  it("answers expired once the server instant has passed without a status call", async () => {
    const calls: Call[] = [];
    const expiredFetch: typeof fetch = async (input, init) => {
      calls.push({ method: init?.method ?? "GET", url: new URL(String(input)) });
      return json(200, {
        loginUrl: "https://www.codebuff.com/login?code=abc123",
        fingerprintHash: "hash-1",
        expiresAt: "2000-01-01T00:00:00.000Z",
      });
    };
    await startLogin("work", env(), expiredFetch);

    const statusCalls: Call[] = [];
    const result = await pollLogin("work", env(), fakeFetch(statusCalls));

    expect(result).toEqual({ status: "expired" });
    expect(statusCalls).toHaveLength(0);
    // A pending handshake stays until cancelled or restarted.
    expect(fs.existsSync(path.join(configDirFor("work"), ".login-pending.json"))).toBe(true);
  });

  it("on success writes credentials 0600, registers the account, clears pending, no token in output", async () => {
    const calls: Call[] = [];
    await startLogin("work", env(), fakeFetch(calls), "Work");

    const statusCalls: Call[] = [];
    const result = await pollLogin("work", env(), fakeFetch(statusCalls, successStatusHandler));

    expect(result).toEqual({ status: "success", name: "Test User", email: "user@example.com" });
    expect(JSON.stringify(result)).not.toContain("authToken");

    // Credentials file in the Freebuff CLI format, mode 0600.
    const credentialsPath = path.join(configDirFor("work"), "credentials.json");
    expect(fs.statSync(credentialsPath).mode & 0o777).toBe(0o600);
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    expect(credentials.default).toMatchObject({
      id: "user-1",
      name: "Test User",
      email: "user@example.com",
      authToken: SUCCESS_USER.authToken,
    });
    expect(typeof credentials.default.fingerprintId).toBe("string");

    // Account registered in accounts.json via the atomic add function.
    const registered = JSON.parse(fs.readFileSync(accountsFilePath(env()), "utf8"));
    expect(registered).toEqual([{ id: "work", label: "Work", configDir: configDirFor("work") }]);

    // Pending handshake consumed.
    expect(fs.existsSync(path.join(configDirFor("work"), ".login-pending.json"))).toBe(false);
  });

  it("normalises a null user name to '' like saveUserCredentials does", async () => {
    const calls: Call[] = [];
    await startLogin("work", env(), fakeFetch(calls));
    const statusCalls: Call[] = [];
    const result = await pollLogin(
      "work",
      env(),
      fakeFetch(statusCalls, () => json(200, { user: { ...SUCCESS_USER, name: null } })),
    );

    expect(result).toEqual({
      status: "success",
      name: "user@example.com",
      email: "user@example.com",
    });
    const credentials = JSON.parse(
      fs.readFileSync(path.join(configDirFor("work"), "credentials.json"), "utf8"),
    );
    expect(credentials.default.name).toBe("");
  });

  it("answers pending on transport failure, keeping the pending file", async () => {
    const calls: Call[] = [];
    await startLogin("work", env(), fakeFetch(calls));
    const failing: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await pollLogin("work", env(), failing)).toEqual({ status: "pending" });
    expect(fs.existsSync(path.join(configDirFor("work"), ".login-pending.json"))).toBe(true);
  });
});

describe("cancelLogin", () => {
  it("deletes the pending file and reports cancelled", async () => {
    const calls: Call[] = [];
    await startLogin("work", env(), fakeFetch(calls));
    expect(fs.existsSync(path.join(configDirFor("work"), ".login-pending.json"))).toBe(true);

    expect(cancelLogin("work", env())).toEqual({ status: "cancelled" });
    expect(fs.existsSync(path.join(configDirFor("work"), ".login-pending.json"))).toBe(false);
    // Idempotent: cancelling again stays cancelled.
    expect(cancelLogin("work", env())).toEqual({ status: "cancelled" });
  });

  it("rejects an invalid id", () => {
    expect(() => cancelLogin("default", env())).toThrow(/Invalid account id/i);
    expect(() => cancelLogin("Bad Id", env())).toThrow(/Invalid account id/i);
  });
});
