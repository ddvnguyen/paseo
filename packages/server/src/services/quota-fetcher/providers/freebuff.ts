import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageDetail,
  ProviderUsageWindow,
} from "../../../server/messages.js";
import { resolvePaseoHome } from "../../../server/paseo-home.js";
import type { ProviderUsageFetcher } from "../provider.js";
import { toneFromUsedPct, unavailableUsage, windowFromUsedPct } from "../usage.js";

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

interface FreebuffQuotaProviderOptions {
  logger: Logger;
  /** Override for tests. */
  runCli?: RunAdapterCli;
  cliPath?: string;
}

/** Where the deployed adapter's CLI lives (see the pipeline's Stage 6). */
export function defaultFreebuffCliPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env["FREEBUFF_ACP_CLI"]?.trim() ||
    join(resolvePaseoHome(env), "freebuff-acp", "current", "plugins", "freebuff", "dist", "cli.js")
  );
}

function accountWindow(account: StatusReport["accounts"][number]): ProviderUsageWindow | null {
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
    label: `${account.label} · ${status.dailyRemaining}/${status.dailyLimit} Freebucks left today`,
    utilizationPct: usedPct,
    resetsAt: status.resetAt ?? null,
    tone: toneFromUsedPct(usedPct),
  });
}

function reportDetails(report: StatusReport): ProviderUsageDetail[] {
  const details: ProviderUsageDetail[] = [];
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
export class FreebuffQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "freebuff";
  readonly displayName = "Freebuff";

  private readonly logger: Logger;
  private readonly runCli: RunAdapterCli;
  private readonly cliPath: string;

  constructor(options: FreebuffQuotaProviderOptions) {
    this.logger = options.logger;
    this.runCli = options.runCli ?? runAdapterCli;
    this.cliPath = options.cliPath ?? defaultFreebuffCliPath();
  }

  /** Injected runners (tests) skip the filesystem check. */
  private cliAvailable(): boolean {
    return this.runCli !== runAdapterCli || existsSync(this.cliPath);
  }

  async fetchUsage(): Promise<ProviderUsage> {
    if (!this.cliAvailable()) return unavailableUsage(this);

    let report: StatusReport;
    try {
      report = StatusReportSchema.parse(JSON.parse(await this.runCli(this.cliPath, ["status"])));
    } catch (error) {
      this.logger.debug({ err: error }, "Freebuff status fetch failed");
      return unavailableUsage({
        ...this,
        // Never forward the raw error: execFile failures embed the child's
        // stderr and parse errors embed fragments of its output. Details stay
        // in the debug log above.
        error: "Freebuff status unavailable",
      });
    }

    const windows = report.accounts.flatMap((account) => accountWindow(account) ?? []);
    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: windows.length > 0 ? "available" : "unavailable",
      planLabel: report.accounts.length > 1 ? `${report.accounts.length} accounts` : null,
      windows,
      balances: [],
      details: reportDetails(report),
      error: null,
    };
  }
}
