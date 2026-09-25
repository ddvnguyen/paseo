import { describe, expect, it } from "vitest";
import pino from "pino";
import { FreebuffQuotaProvider } from "./freebuff.js";

const logger = pino({ level: "silent" });

function provider(output: unknown | Error) {
  return new FreebuffQuotaProvider({
    logger,
    cliPath: "/nowhere/cli.js",
    runCli: async () => {
      if (output instanceof Error) throw output;
      return JSON.stringify(output);
    },
  });
}

describe("FreebuffQuotaProvider", () => {
  it("maps every account to a quota window and reports the model check", async () => {
    const usage = await provider({
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
    }).fetchUsage();

    expect(usage.status).toBe("available");
    expect(usage.planLabel).toBe("2 accounts");
    expect(usage.windows).toHaveLength(1);
    expect(usage.windows[0]).toMatchObject({
      label: "Duc · 5/25 left",
      usedPct: 80,
      remainingPct: 20,
      resetsAt: "2026-09-25T17:00:00.000Z",
    });
    expect(usage.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Work", value: "Not logged in" }),
        expect.objectContaining({ id: "models_new", value: "crof/kimi-k3-eco" }),
      ]),
    );
  });

  it("is unavailable with a generic error and never forwards the CLI's raw failure text", async () => {
    const usage = await provider(new Error("Command failed: secret-stderr")).fetchUsage();
    expect(usage).toMatchObject({
      status: "error",
      error: "Freebuff status unavailable",
      windows: [],
    });
    expect(JSON.stringify(usage)).not.toContain("secret-stderr");
  });

  it("is unavailable when the adapter is not deployed", async () => {
    const usage = await new FreebuffQuotaProvider({
      logger,
      cliPath: "/definitely/not/here/cli.js",
    }).fetchUsage();
    expect(usage.status).toBe("unavailable");
  });
});
