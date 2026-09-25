#!/usr/bin/env node
import path from "node:path";

import { accountsFilePath, addAccount, removeAccount } from "./accounts.js";
import { cancelLogin, pollLogin, startLogin } from "./login.js";
import { buildStatusReport } from "./status-report.js";

const USAGE = `freebuff-acp-cli <command>

  status                       Quota per account and model-catalog check (JSON)
  accounts add <id> <configDir> [label]
                               Register an extra account (a config dir populated by
                               \`FREEBUFF_CONFIG_DIR=<dir> freebuff login\`)
  accounts remove <id>         Unregister an account
  accounts login-start --id <id> [--label <label>]
                               Start a device-code login: prints {"loginUrl","expiresAt"};
                               open the URL in a browser to approve.
  accounts login-poll --id <id>
                               Check the login: {"status":"pending"|"expired"|"success"|"none"};
                               on success the account is registered (never prints tokens).
  accounts login-cancel --id <id>
                               Abandon an in-progress login: {"status":"cancelled"}
`;

/** The one required flag of a login subcommand (`--id <id>`), or null. */
function flagValue(flag: string, argv: string[]): string | null {
  const index = argv.indexOf(flag);
  if (index < 0 || index + 1 >= argv.length) return null;
  return argv[index + 1];
}

/** The `accounts login-*` subcommands; null when this is not a login command. */
async function runLoginCommand(subcommand: string, rest: string[]): Promise<number | null> {
  if (subcommand === "login-start") {
    const id = flagValue("--id", rest);
    const label = flagValue("--label", rest) ?? undefined;
    if (!id) throw new Error("usage: accounts login-start --id <id> [--label <label>]");
    console.log(JSON.stringify(await startLogin(id, process.env, fetch, label), null, 2));
    return 0;
  }
  if (subcommand === "login-poll") {
    const id = flagValue("--id", rest);
    if (!id) throw new Error("usage: accounts login-poll --id <id>");
    console.log(JSON.stringify(await pollLogin(id), null, 2));
    return 0;
  }
  if (subcommand === "login-cancel") {
    const id = flagValue("--id", rest);
    if (!id) throw new Error("usage: accounts login-cancel --id <id>");
    console.log(JSON.stringify(cancelLogin(id), null, 2));
    return 0;
  }
  return null;
}

async function main(argv: string[]): Promise<number> {
  const [command, subcommand, ...rest] = argv;
  if (command === "status") {
    console.log(JSON.stringify(await buildStatusReport(), null, 2));
    return 0;
  }
  if (command === "accounts" && subcommand === "add") {
    const [id, configDir, ...label] = rest;
    if (!id || !configDir) throw new Error("usage: accounts add <id> <configDir> [label]");
    addAccount({ id, configDir: path.resolve(configDir), label: label.join(" ") });
    console.log(`Registered "${id}" in ${accountsFilePath()}`);
    return 0;
  }
  if (command === "accounts" && subcommand === "remove") {
    const [id] = rest;
    if (!id) throw new Error("usage: accounts remove <id>");
    console.log(removeAccount(id) ? `Removed "${id}"` : `No such account "${id}"`);
    return 0;
  }
  if (command === "accounts" && subcommand) {
    const login = await runLoginCommand(subcommand, rest);
    if (login !== null) return login;
  }
  console.error(USAGE);
  return command ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
