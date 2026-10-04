import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  toneFromUsedPct,
  unavailable,
  type UsageAccount,
  type UsageDetail,
  type UsageReport,
  type UsageScope,
  type UsageWindow,
  windowFromUsedPct,
} from "@getpaseo/plugin/server/usage";
import { inputSchema, type UsageInput } from "../shared/input.js";

const CLI_TIMEOUT_MS = 30_000;

const AccountStatusSchema = z.object({
  dailyRemaining: z.number().optional(),
  dailyLimit: z.number().optional(),
  resetAt: z.string().optional(),
  walletBalance: z.number().optional(),
});

/** Output of `freebuff-acp-cli status` (never contains tokens). */
const StatusReportSchema = z.object({
  accounts: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      authenticated: z.boolean(),
      status: AccountStatusSchema.nullable(),
    }),
  ),
  modelCheck: z.object({
    checked: z.boolean(),
    missingInAdapter: z.array(z.string()),
    missingOnServer: z.array(z.string()),
  }),
});

type StatusReport = z.infer<typeof StatusReportSchema>;

export type RunAdapterCli = (cliPath: string, args: string[]) => Promise<string>;

function runAdapterCli(cliPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Where the deployed adapter's CLI lives (see the pipeline's Stage 6). */
export function defaultFreebuffCliPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env["FREEBUFF_ACP_CLI"]?.trim() ||
    join(
      env["PASEO_HOME"]?.trim() || join(homedir(), ".paseo"),
      "freebuff-acp",
      "current",
      "plugins",
      "freebuff",
      "dist",
      "cli.js",
    )
  );
}

function cliAvailable(cliPath: string): boolean {
  return existsSync(cliPath);
}

function accountWindow(account: StatusReport["accounts"][number]): UsageWindow | null {
  const status = account.status;
  if (!status || status.dailyLimit == null || status.dailyRemaining == null) return null;
  const usedPct =
    status.dailyLimit > 0
      ? Math.max(
          0,
          Math.min(100, ((status.dailyLimit - status.dailyRemaining) / status.dailyLimit) * 100),
        )
      : null;
  return windowFromUsedPct({
    id: `account_${account.id}`,
    label: `${account.label} · ${status.dailyRemaining}/${status.dailyLimit} daily`,
    utilizationPct: usedPct,
    resetsAt: status.resetAt ?? null,
    tone: toneFromUsedPct(usedPct),
  });
}

function reportDetails(report: StatusReport): UsageDetail[] {
  const details: UsageDetail[] = [];
  for (const account of report.accounts) {
    if (!account.authenticated) {
      details.push({
        id: `account_${account.id}_auth`,
        label: account.label,
        value: "Not logged in",
        tone: "warning",
      });
    } else if (account.status?.walletBalance != null) {
      details.push({
        id: `account_${account.id}_wallet`,
        label: `${account.label} wallet`,
        value: `${account.status.walletBalance} Freebucks`,
      });
    }
  }
  const { modelCheck } = report;
  if (!modelCheck.checked) return details;
  if (modelCheck.missingInAdapter.length === 0 && modelCheck.missingOnServer.length === 0) {
    details.push({ id: "models", label: "Models", value: "Adapter matches the server" });
    return details;
  }
  if (modelCheck.missingInAdapter.length > 0) {
    details.push({
      id: "models_new",
      label: "New on server (not selectable yet)",
      value: modelCheck.missingInAdapter.join(", "),
      tone: "warning",
    });
  }
  if (modelCheck.missingOnServer.length > 0) {
    details.push({
      id: "models_gone",
      label: "No longer priced by server",
      value: modelCheck.missingOnServer.join(", "),
      tone: "warning",
    });
  }
  return details;
}

/**
 * Freebuff quota per registered account plus the model-catalog check, read
 * through the deployed adapter's CLI so credentials and account logic stay in
 * one place (the adapter). Unavailable when the adapter is not deployed.
 */
export async function fetchUsage(
  input: UsageInput,
  runCli: RunAdapterCli = runAdapterCli,
): Promise<UsageReport> {
  if (!cliAvailable(input.cliPath)) {
    return unavailable({ kind: "no_quota", detail: "The Freebuff adapter is not deployed" });
  }

  let report: StatusReport;
  try {
    report = StatusReportSchema.parse(JSON.parse(await runCli(input.cliPath, ["status"])));
  } catch {
    // Never forward the raw error: execFile failures embed the child's stderr and
    // parse errors embed fragments of its output. The registry turns this throw into
    // { status: "error", error: message }, so the message must stay generic.
    throw new Error("Freebuff status unavailable");
  }

  const windows = report.accounts.flatMap((account) => accountWindow(account) ?? []);
  if (windows.length === 0) {
    return unavailable({ kind: "no_quota", detail: "No Freebuff account reports a quota" });
  }
  return {
    status: "available",
    ...(report.accounts.length > 1 ? { planLabel: `${report.accounts.length} accounts` } : {}),
    windows,
    details: reportDetails(report),
  };
}

/**
 * One account covers the whole adapter: `status` already reports every account the
 * adapter holds. A scope that is not `global` yields nothing, matching kimi.
 */
export async function discover(scope: UsageScope): Promise<UsageAccount[]> {
  if (scope.kind !== "global") return [];
  const cliPath = defaultFreebuffCliPath();
  if (!cliAvailable(cliPath)) return [];
  return [{ key: "default", input: inputSchema.parse({ cliPath }) }];
}