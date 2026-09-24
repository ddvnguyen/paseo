#!/usr/bin/env node
import path from "node:path";

import { accountsFilePath, addAccount, removeAccount } from "./accounts.js";
import { buildStatusReport } from "./status-report.js";

const USAGE = `freebuff-acp-cli <command>

  status                       Quota per account and model-catalog check (JSON)
  accounts add <id> <configDir> [label]
                               Register an extra account (a config dir populated by
                               \`FREEBUFF_CONFIG_DIR=<dir> freebuff login\`)
  accounts remove <id>         Unregister an account
`;

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
