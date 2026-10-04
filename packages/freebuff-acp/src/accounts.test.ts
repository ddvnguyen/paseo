import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  accountDisplayName,
  accountsPrefsFilePath,
  addAccount,
  deriveAccountId,
  findAccount,
  listAccounts,
  readAccountsPrefs,
  readAccountsSnapshot,
  removeAccount,
  renameAccount,
  resolveDefaultAccountId,
  setDefaultAccount,
} from "./accounts.js";
import { resolveAccountLabel } from "./auth.js";

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

/** Credentials for the built-in default account (its config dir in this test). */
function withDefaultConfigDir(e: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  return { ...e, FREEBUFF_CONFIG_DIR: dir };
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

describe("accounts-prefs file", () => {
  it("lives next to accounts.json and reads as no-preferences when missing", () => {
    expect(accountsPrefsFilePath(env())).toBe(path.join(stateDir, "accounts-prefs.json"));
    expect(readAccountsPrefs(env())).toEqual({});
    expect(resolveDefaultAccountId(env())).toBe("default");
  });

  it("treats a corrupt prefs file as no-preferences and never throws", () => {
    fs.writeFileSync(accountsPrefsFilePath(env()), "{ broken json");
    expect(readAccountsPrefs(env())).toEqual({});
    expect(resolveDefaultAccountId(env())).toBe("default");
    expect(findAccount(undefined, env())?.id).toBe("default");
  });

  it("writes 0600 with no temp files left behind", () => {
    setDefaultAccount("default", env());
    const prefsFile = accountsPrefsFilePath(env());
    expect(fs.statSync(prefsFile).mode & 0o777).toBe(0o600);
    const leftovers = fs.readdirSync(stateDir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("default account resolution", () => {
  it("findAccount(undefined) follows the stored default", () => {
    addAccount(VALID_ACCOUNT, env());
    expect(findAccount(undefined, env())?.id).toBe("default");
    setDefaultAccount("work", env());
    expect(findAccount(undefined, env())?.id).toBe("work");
  });

  it("a removed chosen default self-heals back to the built-in default", () => {
    addAccount(VALID_ACCOUNT, env());
    setDefaultAccount("work", env());
    expect(resolveDefaultAccountId(env())).toBe("work");
    removeAccount("work", env());
    expect(resolveDefaultAccountId(env())).toBe("default");
    expect(findAccount(undefined, env())?.id).toBe("default");
  });

  it("set-default rejects unknown and invalid ids but always allows 'default'", () => {
    expect(() => setDefaultAccount("ghost", env())).toThrow(/No such account/);
    expect(() => setDefaultAccount("Bad Id", env())).toThrow(/Invalid account id/);
    expect(() => setDefaultAccount("default", env())).not.toThrow();
    expect(resolveDefaultAccountId(env())).toBe("default");
  });

  it("an unknown stored default falls back to the built-in default", () => {
    fs.writeFileSync(accountsPrefsFilePath(env()), JSON.stringify({ defaultAccountId: "ghost" }));
    expect(resolveDefaultAccountId(env())).toBe("default");
  });
});

describe("renameAccount", () => {
  it("rewrites a registered account's label in accounts.json", () => {
    addAccount(VALID_ACCOUNT, env());
    const renamed = renameAccount("work", "Work laptop", env());
    expect(renamed?.label).toBe("Work laptop");
    expect(readAccountsSnapshot(env()).accounts).toEqual([
      { id: "work", label: "Work laptop", configDir: "/abs/work" },
    ]);
    expect(listAccounts(env()).map((account) => account.id)).toEqual(["default", "work"]);
  });

  it("an empty label clears a registered account's override", () => {
    addAccount(VALID_ACCOUNT, env());
    renameAccount("work", "", env());
    expect(readAccountsSnapshot(env()).accounts).toEqual([{ id: "work", configDir: "/abs/work" }]);
  });

  it("stores the built-in default's label override in the prefs file", () => {
    renameAccount("default", "Personal", env());
    expect(readAccountsPrefs(env()).defaultLabel).toBe("Personal");
    renameAccount("default", "", env());
    expect(readAccountsPrefs(env()).defaultLabel).toBeUndefined();
  });

  it("refuses to rename when the accounts file is corrupt", () => {
    fs.writeFileSync(accountsFile, "not json");
    expect(() => renameAccount("work", "X", env())).toThrow(/Refusing to update/i);
  });

  it("rejects unknown and invalid ids", () => {
    addAccount(VALID_ACCOUNT, env());
    expect(() => renameAccount("ghost", "X", env())).toThrow(/No such account/);
    expect(() => renameAccount("Bad Id", "X", env())).toThrow(/Invalid account id/);
  });
});

describe("deriveAccountId", () => {
  function credentialsDir(apiUserId: string): string {
    const dir = fs.mkdtempSync(path.join(stateDir, "creds-"));
    fs.writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({ default: { id: apiUserId, authToken: "t" } }),
    );
    return dir;
  }

  it("uses the sanitized API user id when free", () => {
    expect(deriveAccountId({ id: "user-1", email: "user@example.com" }, env())).toEqual({
      id: "user-1",
      reusedConfigDir: null,
    });
  });

  it("falls back to the email local-part, then 'account', skipping reserved ids", () => {
    expect(deriveAccountId({ id: "!!!", email: "bob@example.com" }, env()).id).toBe("bob");
    expect(deriveAccountId({ id: "default", email: "default@example.com" }, env()).id).toBe(
      "account",
    );
  });

  it("suffixes when the base id belongs to a different API user", () => {
    const otherDir = credentialsDir("someone-else");
    fs.writeFileSync(accountsFile, JSON.stringify([{ id: "user-1", configDir: otherDir }]));
    expect(deriveAccountId({ id: "user-1", email: "user@example.com" }, env()).id).toBe("user-1-2");
  });

  it("reuses the id and config dir when the same API user re-logs in", () => {
    const homeDir = credentialsDir("user-1");
    fs.writeFileSync(accountsFile, JSON.stringify([{ id: "user-1", configDir: homeDir }]));
    expect(deriveAccountId({ id: "user-1", email: "user@example.com" }, env())).toEqual({
      id: "user-1",
      reusedConfigDir: homeDir,
    });
  });
});

describe("accountDisplayName", () => {
  it("honors the built-in default's defaultLabel override", () => {
    const cliDir = path.join(stateDir, "cli");
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(
      path.join(cliDir, "credentials.json"),
      JSON.stringify({ default: { name: "Duc", authToken: "t" } }),
    );
    const e = withDefaultConfigDir(env(), cliDir);
    const defaultAccount = listAccounts(e)[0];
    expect(defaultAccount).not.toBeNull();
    if (!defaultAccount) return;
    expect(accountDisplayName(defaultAccount, e)).toBe("Duc");
    renameAccount("default", "Personal", e);
    expect(accountDisplayName(defaultAccount, e)).toBe("Personal");
    expect(resolveAccountLabel({ FREEBUFF_CONFIG_DIR: cliDir })).toBe("Duc");
  });

  it("registered accounts keep their own label over the credentials name", () => {
    addAccount(VALID_ACCOUNT, env());
    const work = findAccount("work", env());
    expect(work?.label).toBe("Work");
    expect(accountDisplayName(work!, env())).toBe("Work");
  });
});
