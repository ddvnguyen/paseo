import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cliSettingsFromJson,
  endAccountSession,
  listAccountDetails,
  removeAccountAndState,
  renameAccountLabel,
  setAccountDefault,
} from "./account-admin.js";
import { accountConfigDir, addAccount } from "./accounts.js";

const SECRET_TOKEN = "tok-secret-value";
const INSTANCE_ID = "instance-secret-id";

let stateDir = "";
let defaultDir = "";

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-acp-admin-"));
  defaultDir = path.join(stateDir, "default-cli");
  fs.mkdirSync(defaultDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function env(): NodeJS.ProcessEnv {
  return {
    FREEBUFF_CONFIG_DIR: defaultDir,
    FREEBUFF_ACP_CONFIG_DIR: stateDir,
    FREEBUFF_ACP_ACCOUNTS_FILE: path.join(stateDir, "accounts.json"),
  };
}

function writeCredentials(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "credentials.json"),
    JSON.stringify({ default: { id: "u", name, email: `${name}@x.y`, authToken: SECRET_TOKEN } }),
  );
}

interface SeatServer {
  calls: { method: string; instanceHeader: string | null }[];
}

/** Stub fetch: GET answers `seat`, DELETE succeeds. */
function stubSeat(seat: Record<string, unknown> | "fail"): SeatServer {
  const server: SeatServer = { calls: [] };
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    server.calls.push({
      method: init?.method ?? "GET",
      instanceHeader: headers.get("x-freebuff-instance-id"),
    });
    if (seat === "fail") return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(seat), { status: 200 });
  });
  return server;
}

describe("cliSettingsFromJson", () => {
  it("keeps the read-only preferences and drops everything else", () => {
    const view = cliSettingsFromJson({
      mode: "LITE",
      freebuffModel: "z-ai/glm-5.3-flash",
      adsEnabled: false,
      freebuffReasoningEfforts: { "z-ai/glm-5.3-flash": "high", bad: 3 },
      alwaysUseALaCarte: true,
      byokConnection: { id: "secret-connection-id", model: "m" },
      hasSubmittedFirstPrompt: true,
    });
    expect(view).toEqual({
      mode: "LITE",
      freebuffModel: "z-ai/glm-5.3-flash",
      adsEnabled: false,
      freebuffReasoningEfforts: { "z-ai/glm-5.3-flash": "high" },
    });
    expect(JSON.stringify(view)).not.toContain("secret-connection-id");
    expect(view).not.toHaveProperty("fallbackToALaCarte");
    expect(view).not.toHaveProperty("byokConnected");
  });

  it("returns an empty view for non-objects", () => {
    expect(cliSettingsFromJson(null)).toEqual({});
    expect(cliSettingsFromJson([1])).toEqual({});
  });
});

describe("listAccountDetails", () => {
  it("reports seat, quota and CLI settings per account without any secret", async () => {
    writeCredentials(defaultDir, "Duc");
    fs.writeFileSync(path.join(defaultDir, "settings.json"), JSON.stringify({ mode: "LITE" }));
    const workDir = accountConfigDir("work", env());
    writeCredentials(workDir, "Work");
    addAccount({ id: "work", label: "Work", configDir: workDir }, env());
    stubSeat({
      status: "active",
      instanceId: INSTANCE_ID,
      model: "z-ai/glm-5.3-flash",
      freebucks: { daily: { limit: 25, remaining: 20 }, prices: {} },
    });

    const { accounts } = await listAccountDetails(env());

    expect(accounts.map((account) => account.id)).toEqual(["default", "work"]);
    expect(accounts[0]).toMatchObject({
      isDefault: true,
      authenticated: true,
      managed: false,
      seat: { state: "active", model: "z-ai/glm-5.3-flash" },
      status: { dailyRemaining: 20, dailyLimit: 25 },
      cliSettings: { mode: "LITE" },
    });
    expect(accounts[1]).toMatchObject({ isDefault: false, managed: true, cliSettings: null });
    // Choosing the extra account as default flips isDefault, not the id list.
    setAccountDefault("work", env());
    const chosen = await listAccountDetails(env());
    expect(chosen.accounts.map((account) => account.isDefault)).toEqual([false, true]);
    setAccountDefault("default", env());
    const restored = await listAccountDetails(env());
    expect(restored.accounts.map((account) => account.isDefault)).toEqual([true, false]);
    const serialized = JSON.stringify(accounts);
    expect(serialized).not.toContain(SECRET_TOKEN);
    expect(serialized).not.toContain(INSTANCE_ID);
  });

  it("reports an unknown seat when the probe fails and none when unauthenticated", async () => {
    writeCredentials(defaultDir, "Duc");
    const emptyDir = accountConfigDir("empty", env());
    fs.mkdirSync(emptyDir, { recursive: true });
    addAccount({ id: "empty", configDir: emptyDir }, env());
    stubSeat("fail");

    const { accounts } = await listAccountDetails(env());

    expect(accounts[0].seat).toEqual({ state: "unknown" });
    expect(accounts[1]).toMatchObject({ authenticated: false, seat: { state: "none" } });
  });

  it("exposes the stored login email/name and never secrets", async () => {
    writeCredentials(defaultDir, "Duc");
    const workDir = accountConfigDir("work", env());
    writeCredentials(workDir, "Work");
    addAccount({ id: "work", configDir: workDir }, env());
    stubSeat({ status: "none" });

    const { accounts } = await listAccountDetails(env());

    expect(accounts[0]).toMatchObject({ name: "Duc", email: "Duc@x.y" });
    expect(accounts[1]).toMatchObject({ name: "Work", email: "Work@x.y" });
    const serialized = JSON.stringify(accounts);
    expect(serialized).not.toContain(SECRET_TOKEN);
  });

  it("omits email/name when no stored login record exists", async () => {
    const emptyDir = accountConfigDir("empty", env());
    fs.mkdirSync(emptyDir, { recursive: true });
    addAccount({ id: "empty", configDir: emptyDir }, env());
    stubSeat({ status: "none" });

    const { accounts } = await listAccountDetails(env());

    const empty = accounts.find((account) => account.id === "empty");
    expect(empty).toMatchObject({ authenticated: false });
    expect(empty).not.toHaveProperty("email");
    expect(empty).not.toHaveProperty("name");
  });
});

describe("endAccountSession", () => {
  it("releases an active seat with its instance id", async () => {
    writeCredentials(defaultDir, "Duc");
    const server = stubSeat({ status: "active", instanceId: INSTANCE_ID });
    expect(await endAccountSession("default", env())).toEqual({ result: "ended" });
    expect(server.calls.at(-1)).toEqual({ method: "DELETE", instanceHeader: INSTANCE_ID });
  });

  it("does nothing when no seat is held", async () => {
    writeCredentials(defaultDir, "Duc");
    const server = stubSeat({ status: "none" });
    expect(await endAccountSession("default", env())).toEqual({ result: "no-session" });
    expect(server.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reports unknown when the probe fails and rejects an unknown account", async () => {
    writeCredentials(defaultDir, "Duc");
    stubSeat("fail");
    expect(await endAccountSession("default", env())).toEqual({ result: "unknown" });
    await expect(endAccountSession("ghost", env())).rejects.toThrow(/No such account/);
  });
});

describe("setAccountDefault / renameAccountLabel", () => {
  it("set-default rejects an unknown account", () => {
    expect(() => setAccountDefault("ghost", env())).toThrow(/No such account/);
  });

  it("renames a registered account and reports the new display label", async () => {
    const workDir = accountConfigDir("work", env());
    writeCredentials(workDir, "Work");
    addAccount({ id: "work", configDir: workDir }, env());
    expect(renameAccountLabel("work", "Work laptop", env())).toEqual({
      id: "work",
      label: "Work laptop",
    });
    const { accounts } = await listAccountDetails(env());
    expect(accounts[1]?.label).toBe("Work laptop");
  });

  it("renames the built-in default via the prefs file", async () => {
    writeCredentials(defaultDir, "Duc");
    expect(renameAccountLabel("default", "Personal", env())).toEqual({
      id: "default",
      label: "Personal",
    });
    const { accounts } = await listAccountDetails(env());
    expect(accounts[0]?.label).toBe("Personal");
    // Empty label clears the override.
    expect(renameAccountLabel("default", "", env()).label).toBe("Duc");
  });
});

describe("removeAccountAndState", () => {
  it("deletes an adapter-managed account's credentials dir", () => {
    const workDir = accountConfigDir("work", env());
    writeCredentials(workDir, "Work");
    addAccount({ id: "work", configDir: workDir }, env());
    expect(removeAccountAndState("work", env())).toEqual({
      removed: true,
      deletedCredentials: true,
    });
    expect(fs.existsSync(workDir)).toBe(false);
  });

  it("keeps a user-supplied freebuff-login dir", () => {
    const external = path.join(stateDir, "manicode-work");
    writeCredentials(external, "Work");
    addAccount({ id: "work", configDir: external }, env());
    expect(removeAccountAndState("work", env())).toEqual({
      removed: true,
      deletedCredentials: false,
    });
    expect(fs.existsSync(path.join(external, "credentials.json"))).toBe(true);
  });

  it("cannot remove the default account", () => {
    expect(() => removeAccountAndState("default", env())).toThrow();
  });

  it("removing the chosen default resets it to the built-in default", async () => {
    const workDir = accountConfigDir("work", env());
    writeCredentials(workDir, "Work");
    addAccount({ id: "work", configDir: workDir }, env());
    setAccountDefault("work", env());
    removeAccountAndState("work", env());
    const { accounts } = await listAccountDetails(env());
    expect(accounts.map((account) => account.id)).toEqual(["default"]);
    expect(accounts[0]?.isDefault).toBe(true);
  });
});
