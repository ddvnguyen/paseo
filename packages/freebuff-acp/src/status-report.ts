import {
  accountDisplayName,
  credentialsForAccount,
  listAccounts,
  type FreebuffAccount,
} from "./accounts.js";
import { type AccountStatus, fetchAccountStatus } from "./account.js";
import { FREEBUFF_AGENT_ID_BY_MODEL } from "./freebuff-agent.js";

export interface AccountReport {
  id: string;
  label: string;
  /** False when the account has no usable credentials. */
  authenticated: boolean;
  /** Null when unauthenticated or the server did not answer in time. */
  status: AccountStatus | null;
}

export interface ModelCheck {
  /** Priced by the server but unknown to the adapter: cannot be selected yet. */
  missingInAdapter: string[];
  /** Known to the adapter but no longer priced by the server: likely retired. */
  missingOnServer: string[];
  /** False when no account could reach the server, so the diff is meaningless. */
  checked: boolean;
}

export interface StatusReport {
  accounts: AccountReport[];
  modelCheck: ModelCheck;
}

/** Diff the server's price table against the adapter's model catalog. */
export function checkModels(serverModelIds: string[] | null): ModelCheck {
  if (!serverModelIds) return { missingInAdapter: [], missingOnServer: [], checked: false };
  const adapterIds = Object.keys(FREEBUFF_AGENT_ID_BY_MODEL);
  return {
    checked: true,
    missingInAdapter: serverModelIds.filter((id) => !adapterIds.includes(id)).sort(),
    missingOnServer: adapterIds.filter((id) => !serverModelIds.includes(id)).sort(),
  };
}

async function reportAccount(
  account: FreebuffAccount,
  env: NodeJS.ProcessEnv,
): Promise<AccountReport> {
  const credentials = credentialsForAccount(account, env);
  return {
    id: account.id,
    label: accountDisplayName(account, env),
    authenticated: credentials !== null,
    status: credentials ? await fetchAccountStatus(credentials.apiKey) : null,
  };
}

/** Quota for every registered account plus the model-catalog check. Never contains tokens. */
export async function buildStatusReport(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StatusReport> {
  const accounts = await Promise.all(
    listAccounts(env).map((account) => reportAccount(account, env)),
  );
  const priced = accounts.find((account) => account.status)?.status?.prices;
  return { accounts, modelCheck: checkModels(priced ? Object.keys(priced) : null) };
}
