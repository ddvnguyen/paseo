import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discover, fetchUsage, type RunAdapterCli } from "./usage.js";

const GLOBAL = { kind: "global" } as const;

const tempDirs: string[] = [];

function deployedCli(): string {
  const dir = mkdtempSync(join(tmpdir(), "paseo-freebuff-usage-"));
  tempDirs.push(dir);
  const cliPath = join(dir, "cli.js");
  writeFileSync(cliPath, "// stand-in for the deployed adapter CLI\n");
  return cliPath;
}

function runner(output: unknown | Error): RunAdapterCli {
  return async () => {
    if (output instanceof Error) throw output;
    return JSON.stringify(output);
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("freebuff usage source", () => {
  it("maps every account to a quota window and reports the model check", async () => {
    const report = await fetchUsage(
      { cliPath: deployedCli() },
      runner({
        accounts: [
          {
            id: "default",
            label: "Duc",
            authenticated: true,
            status: { dailyRemaining: 5, dailyLimit: 25, resetAt: "2026-09-25T17:00:00.000Z" },
          },
          { id: "work", label: "Work", authenticated: false, status: null },
        ],
        modelCheck: {
          checked: true,
          missingInAdapter: ["crof/kimi-k3-eco"],
          missingOnServer: [],
        },
      }),
    );

    expect(report.status).toBe("available");
    if (report.status !== "available") throw new Error("expected an available report");
    expect(report.planLabel).toBe("2 accounts");
    expect(report.windows).toHaveLength(1);
    expect(report.windows[0]).toMatchObject({
      label: "Duc · 5/25 daily",
      usedPct: 80,
      remainingPct: 20,
      resetsAt: "2026-09-25T17:00:00.000Z",
    });
    expect(report.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Work", value: "Not logged in" }),
        expect.objectContaining({ id: "models_new", value: "crof/kimi-k3-eco" }),
      ]),
    );
  });

  it("throws a generic error and never forwards the CLI's raw failure text", async () => {
    const failure = fetchUsage(
      { cliPath: deployedCli() },
      runner(new Error("Command failed: secret-stderr")),
    );

    await expect(failure).rejects.toThrow("Freebuff status unavailable");
    await expect(failure).rejects.not.toThrow(/secret-stderr/u);
  });

  it("is unavailable when the adapter is not deployed", async () => {
    const report = await fetchUsage({ cliPath: "/definitely/not/here/cli.js" });

    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: "The Freebuff adapter is not deployed" },
    });
  });

  it("discovers nothing outside the global scope", async () => {
    await expect(
      discover({ kind: "session", provider: "freebuff", env: {} }),
    ).resolves.toEqual([]);
  });
});