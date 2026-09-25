import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addAccount, listAccounts, readAccountsSnapshot, removeAccount } from "./accounts.js";

let stateDir = "";
let accountsFile = "";

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-acp-accounts-"));
  accountsFile = path.join(stateDir, "accounts.json");
});

afterEach(() => {
  if (stateDir) {
    fs.rmSync(stateDir, { recursive: true, force: true });
    stateDir = "";
    accountsFile = "";
  }
});

function env(): NodeJS.ProcessEnv {
  return { FREEBUFF_ACP_ACCOUNTS_FILE: accountsFile };
}

const VALID_ACCOUNT = { id: "work", label: "Work", configDir: "/abs/work" };

describe("accounts file state (F5)", () => {
  it("treats a missing file as missing, not corrupt, falling back to the default account", () => {
    const snapshot = readAccountsSnapshot(env());
    expect(snapshot.state).toBe("missing");
    expect(snapshot.accounts).toEqual([]);
    expect(listAccounts(env()).map((account) => account.id)).toEqual(["default"]);
  });

  it("parses a valid file into the ok state", () => {
    fs.writeFileSync(accountsFile, JSON.stringify([VALID_ACCOUNT]));
    const snapshot = readAccountsSnapshot(env());
    expect(snapshot.state).toBe("ok");
    expect(snapshot.accounts).toEqual([VALID_ACCOUNT]);
    expect(listAccounts(env()).map((account) => account.id)).toEqual(["default", "work"]);
  });

  it("reports corrupt (not empty) for a torn file and still serves the default account", () => {
    fs.writeFileSync(accountsFile, '{"id": "wor'); // torn JSON — never parses
    const snapshot = readAccountsSnapshot(env());
    expect(snapshot.state).toBe("corrupt");
    expect(snapshot.accounts).toEqual([]);
    // Readers fall back to default-only, but the corrupt signal is visible.
    expect(listAccounts(env()).map((account) => account.id)).toEqual(["default"]);
  });

  it("reports corrupt for a parseable but non-array file", () => {
    fs.writeFileSync(accountsFile, JSON.stringify({ id: "work" }));
    expect(readAccountsSnapshot(env()).state).toBe("corrupt");
  });

  it("reports corrupt for an unreadable file (exists but cannot be read)", () => {
    fs.writeFileSync(accountsFile, JSON.stringify([VALID_ACCOUNT]));
    fs.chmodSync(accountsFile, 0o000);
    try {
      expect(readAccountsSnapshot(env()).state).toBe("corrupt");
    } finally {
      fs.chmodSync(accountsFile, 0o600);
    }
  });
});

describe("addAccount / removeAccount on a corrupt file (F5)", () => {
  function corrupt() {
    fs.writeFileSync(accountsFile, "not json at all");
  }

  it("refuses addAccount and keeps the corrupt file byte-for-byte", () => {
    corrupt();
    const before = fs.readFileSync(accountsFile, "utf8");
    expect(() => addAccount(VALID_ACCOUNT, env())).toThrow(/Refusing to update/i);
    expect(fs.readFileSync(accountsFile, "utf8")).toBe(before);
  });

  it("refuses removeAccount and keeps the corrupt file byte-for-byte", () => {
    corrupt();
    const before = fs.readFileSync(accountsFile, "utf8");
    expect(() => removeAccount("work", env())).toThrow(/Refusing to update/i);
    expect(fs.readFileSync(accountsFile, "utf8")).toBe(before);
  });

  it("still validates ids and paths before consulting the file", () => {
    expect(() => addAccount({ id: "Bad Id", configDir: "/abs" }, env())).toThrow(
      /Invalid account id/,
    );
    expect(() => addAccount({ id: "ok", configDir: "relative/dir" }, env())).toThrow(
      /absolute path/,
    );
    expect(() => addAccount({ id: "default", configDir: "/abs" }, env())).toThrow(
      /Invalid account id/,
    );
  });
});

describe("atomic writes (F5)", () => {
  it("writes through a temp file + rename: the result parses and no temp files linger", () => {
    addAccount(VALID_ACCOUNT, env());
    // The visible file is complete JSON with the new account.
    expect(readAccountsSnapshot(env())).toMatchObject({ state: "ok" });
    expect(listAccounts(env()).map((account) => account.id)).toEqual(["default", "work"]);
    // No torn/partial temp files left behind in the directory.
    const leftovers = fs.readdirSync(stateDir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("writes the file with 0600 permissions", () => {
    addAccount(VALID_ACCOUNT, env());
    expect(fs.statSync(accountsFile).mode & 0o777).toBe(0o600);
  });

  it("updates an existing registration in place and removes it on request", () => {
    addAccount(VALID_ACCOUNT, env());
    addAccount({ ...VALID_ACCOUNT, label: "Work II" }, env());
    expect(readAccountsSnapshot(env()).accounts).toHaveLength(1);
    expect(readAccountsSnapshot(env()).accounts[0]?.label).toBe("Work II");

    expect(removeAccount("nope", env())).toBe(false);
    expect(removeAccount("work", env())).toBe(true);
    expect(listAccounts(env()).map((account) => account.id)).toEqual(["default"]);
  });
});
