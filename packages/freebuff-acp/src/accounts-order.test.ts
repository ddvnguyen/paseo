import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  accountsPrefsFilePath,
  addAccount,
  listAccounts,
  listAccountsOrdered,
  readAccountsPrefs,
  reorderAccounts,
  setDefaultAccount,
} from "./accounts.js";

describe("account display order (owner directive 2026-09-26)", () => {
  let home: string;
  let baseEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "fbx-order-"));
    baseEnv = {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      FREEBUFF_ACP_CONFIG_DIR: path.join(home, ".config", "freebuff-acp"),
    } as NodeJS.ProcessEnv;
    addAccount({ id: "work", configDir: "/tmp/does-not-matter-a" }, baseEnv);
    addAccount({ id: "personal", configDir: "/tmp/does-not-matter-b" }, baseEnv);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("stores the full order and lists accounts by it", () => {
    const stored = reorderAccounts(["personal", "default", "work"], baseEnv);
    expect(stored).toEqual(["personal", "default", "work"]);
    expect(listAccountsOrdered(baseEnv).map((a) => a.id)).toEqual(["personal", "default", "work"]);
    expect(readAccountsPrefs(baseEnv).accountOrder).toEqual(["personal", "default", "work"]);
  });

  it("keeps unlisted accounts in registration order after the listed ones", () => {
    reorderAccounts(["work"], baseEnv);
    expect(listAccountsOrdered(baseEnv).map((a) => a.id)).toEqual(["work", "default", "personal"]);
  });

  it("falls back to default-first registration order when no order is stored", () => {
    expect(listAccountsOrdered(baseEnv).map((a) => a.id)).toEqual(["default", "work", "personal"]);
  });

  it("rejects unknown and duplicate ids", () => {
    expect(() => reorderAccounts(["nope"], baseEnv)).toThrow(/No such account/);
    expect(() => reorderAccounts(["work", "work"], baseEnv)).toThrow(/Duplicate account/);
  });

  it("is cosmetic: it never changes the default or the account set", () => {
    setDefaultAccount("work", baseEnv);
    reorderAccounts(["personal", "work", "default"], baseEnv);
    expect(readAccountsPrefs(baseEnv).defaultAccountId).toBe("work");
    expect(new Set(listAccounts(baseEnv).map((a) => a.id))).toEqual(
      new Set(["default", "work", "personal"]),
    );
    // Reorder again to a fresh permutation and confirm persistence round-trip.
    reorderAccounts(["default", "personal", "work"], baseEnv);
    expect(readAccountsPrefs(baseEnv).accountOrder).toEqual(["default", "personal", "work"]);
  });

  it("persists order in the shared prefs file next to accounts.json", () => {
    reorderAccounts(["work", "personal", "default"], baseEnv);
    const prefs = readAccountsPrefs(baseEnv);
    expect(prefs.accountOrder).toEqual(["work", "personal", "default"]);
    expect(accountsPrefsFilePath(baseEnv)).toContain("accounts-prefs.json");
  });
});
