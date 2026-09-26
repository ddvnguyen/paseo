import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FREEBUFF_AGENT_ID_BY_MODEL } from "./freebuff-agent.js";
import { buildStatusReport, checkModels } from "./status-report.js";

let stateDir = "";

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuff-acp-status-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  stateDir = "";
  vi.unstubAllGlobals();
});

describe("checkModels", () => {
  it("reports server models the adapter lacks and adapter models the server dropped", () => {
    const known = Object.keys(FREEBUFF_AGENT_ID_BY_MODEL);
    const check = checkModels([...known.slice(1), "vendor/brand-new"]);
    expect(check).toEqual({
      checked: true,
      missingInAdapter: ["vendor/brand-new"],
      missingOnServer: [known[0]],
    });
  });

  it("does not claim a diff when the server was unreachable", () => {
    expect(checkModels(null)).toEqual({
      checked: false,
      missingInAdapter: [],
      missingOnServer: [],
    });
  });
});

describe("buildStatusReport", () => {
  it("exposes per-account daily quota, prices and price notices (never tokens)", async () => {
    fs.writeFileSync(
      path.join(stateDir, "credentials.json"),
      JSON.stringify({
        default: { id: "u", name: "Duc", email: "duc@x.y", authToken: "tok-secret-value" },
      }),
    );
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            status: "none",
            freebucks: {
              daily: { limit: 25, remaining: 20, resetAt: "2026-09-26T17:00:00.000Z" },
              prices: { "z-ai/glm-5.3-flash": 5 },
              priceNotices: { "z-ai/glm-5.3-flash": "peak hours" },
            },
          }),
          { status: 200 },
        ),
    );

    const report = await buildStatusReport({
      FREEBUFF_CONFIG_DIR: stateDir,
      FREEBUFF_ACP_ACCOUNTS_FILE: path.join(stateDir, "accounts.json"),
    });

    expect(report.accounts).toHaveLength(1);
    expect(report.accounts[0]).toMatchObject({
      id: "default",
      authenticated: true,
      status: {
        dailyRemaining: 20,
        dailyLimit: 25,
        resetAt: "2026-09-26T17:00:00.000Z",
        prices: { "z-ai/glm-5.3-flash": 5 },
        priceNotices: { "z-ai/glm-5.3-flash": "peak hours" },
      },
    });
    expect(JSON.stringify(report)).not.toContain("tok-secret-value");
  });
});
