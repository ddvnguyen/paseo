import { Command, Option } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { startDaemonInstance, resolvePaseoHome } from "@getpaseo/server/daemon-control";
const require = createRequire(import.meta.url);
function resolveServerRunnerFromDir(currentDir: string): string | null {
  const packageJsonPath = path.join(currentDir, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { name?: string };
    if (packageJson.name !== "@getpaseo/server") return null;
    const distRunner = path.join(currentDir, "dist", "scripts", "supervisor-entrypoint.js");
    if (existsSync(distRunner)) {
      return distRunner;
    }
    return path.join(currentDir, "scripts", "supervisor-entrypoint.ts");
  } catch {
    return null;
  }
}

function resolveDaemonRunnerEntry(): string {
  const serverExportPath = require.resolve("@getpaseo/server");
  let currentDir = path.dirname(serverExportPath);

  while (true) {
    const entry = resolveServerRunnerFromDir(currentDir);
    if (entry) {
      return entry;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  throw new Error("Unable to resolve @getpaseo/server package root for daemon runner");
}

export async function launchLocalDaemon(options: {
  home: string;
  timeoutMs?: number;
  foreground?: boolean;
  launchEnv?: Record<string, string>;
}) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const entry = resolveDaemonRunnerEntry();
    return await startDaemonInstance({
      home: resolvePaseoHome({ PASEO_HOME: options.home }),
      command: process.execPath,
      args: [...(entry.endsWith(".ts") ? ["--import", "tsx"] : []), entry],
      env: { ...process.env, ...options.launchEnv },
      mode: options.foreground ? "deployment" : "managed",
      foreground: options.foreground,
      timeoutMs: options.timeoutMs,
      signal: abort.signal,
      onReady: options.foreground
        ? (instance) =>
            process.stdout.write(`Listening on ${instance.listen} (PID ${instance.pid})\n`)
        : undefined,
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

export function parseTimeoutMs(raw: unknown, fallback = 600_000): number {
  if (raw === undefined) return fallback;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw { code: "INVALID_TIMEOUT", message: "Timeout must be a positive number of seconds." };
  return Math.ceil(seconds * 1000);
}

const REMOVED_LAUNCH_FLAGS: Record<string, string> = {
  "--port <port>": "daemon.listen",
  "--listen <listen>": "daemon.listen",
  "--relay": "daemon.relay.enabled",
  "--no-relay": "daemon.relay.enabled",
  "--relay-use-tls": "daemon.relay.useTls",
  "--no-mcp": "daemon.mcp.enabled",
  "--no-inject-mcp": "daemon.mcp.injectIntoAgents",
  "--web-ui": "features.webUi.enabled",
  "--no-web-ui": "features.webUi.enabled",
  "--hostnames <hosts>": "daemon.hostnames",
  "--allowed-hosts <hosts>": "daemon.hostnames",
  "--foreground": "",
};

export function rejectRemovedLaunchFlags(
  command: Command,
  options: { allowLegacyStartFlags?: boolean } = {},
): Command {
  const removed = Object.entries(REMOVED_LAUNCH_FLAGS).filter(
    ([flag]) => !(options.allowLegacyStartFlags && LEGACY_DAEMON_START_SUPPRESSED_KEYS.has(flag)),
  );
  for (const [flag] of removed) command.addOption(new Option(flag).hideHelp());
  command.hook("preAction", () => {
    for (const [flag, configPath] of removed) {
      const name = new Option(flag).attributeName();
      if (command.getOptionValueSource(name) !== "cli") continue;
      throw {
        code: "REMOVED_LAUNCH_OPTION",
        message: `${flag.split(" ")[0]} was removed. ${configPath ? `Use paseo daemon config set ${configPath} <value> --home <path>, then start or restart.` : "Use paseo daemon run --home <path> for foreground deployment."} Deployment environment overrides belong to paseo daemon run.`,
      };
    }
  });
  return command;
}

// COMPAT(daemon-start-flags): added back in v0.9.3, remove after 2027-02-01.
//
// deploy/systemd/paseo.service and paseo-test.service were written against the
// 0.6.x CLI, where `daemon start` was itself the foreground deployment entrypoint
// and accepted --foreground/--listen/--no-web-ui. Those flags were then dropped in
// favour of `daemon run` plus environment overrides. Rewriting the units to `daemon
// run` is the destination, but it cannot be the whole fix: both units execute
// ~/paseo/{PROD,TEST}/paseo-bun, which runs whatever CLI that runtime tree has
// installed, and both currently hold a 0.6.x CLI that has no `daemon run` at all.
// A unit rewritten to `daemon run` would fail to start against the binary it
// actually runs, taking every agent in that cgroup with it. So accept the three
// flags again and map them onto the current launch path; the units then work
// unchanged against both the deployed binary and a future source build.
//
// Only `daemon start` opts in. `run` and `restart` keep rejecting them.
const LEGACY_DAEMON_START_FLAG_KEYS = ["--foreground", "--listen <listen>", "--no-web-ui"];

// `--web-ui` is the positive form of `--no-web-ui`; commander files both under the
// same `webUi` attribute, so leaving the positive one registered as "removed" would
// make it reject `--no-web-ui` too, under the wrong flag name.
const LEGACY_DAEMON_START_SUPPRESSED_KEYS = new Set([...LEGACY_DAEMON_START_FLAG_KEYS, "--web-ui"]);

// A managed launch (`daemon start` with no --foreground) strips the daemon setting
// environment before spawning the supervisor, so these two would silently do
// nothing there. Refusing beats ignoring: a caller who passed --listen would
// otherwise get a daemon on the wrong port with no error.
const LEGACY_DEPLOYMENT_ONLY_FLAGS: ReadonlyArray<{ option: string; flag: string }> = [
  { option: "listen", flag: "--listen" },
  { option: "webUi", flag: "--no-web-ui" },
];

export interface LegacyDaemonStartFlags {
  foreground: boolean;
  launchEnv: Record<string, string>;
}

export function addLegacyDaemonStartFlags(command: Command): Command {
  for (const flag of LEGACY_DAEMON_START_FLAG_KEYS) command.addOption(new Option(flag).hideHelp());
  return command;
}

export function readLegacyDaemonStartFlags(command: Command): LegacyDaemonStartFlags {
  const givenOnCli = (name: string) => command.getOptionValueSource(name) === "cli";
  const foreground = givenOnCli("foreground");

  const withoutForeground = LEGACY_DEPLOYMENT_ONLY_FLAGS.filter(
    (entry) => !foreground && givenOnCli(entry.option),
  ).map((entry) => entry.flag);
  if (withoutForeground.length > 0) {
    throw {
      code: "REMOVED_LAUNCH_OPTION",
      message: `${withoutForeground.join(" and ")} only take effect on a foreground deployment launch. Add --foreground, or use paseo daemon run with PASEO_LISTEN / PASEO_WEB_UI_ENABLED set in the environment.`,
    };
  }

  const launchEnv: Record<string, string> = {};
  // The daemon worker resolves these from its launch environment (config.ts reads
  // PASEO_LISTEN and PASEO_WEB_UI_ENABLED), so that is where a flag has to land.
  // The flag wins over any inherited value, which is what these flags always did.
  if (givenOnCli("listen")) launchEnv.PASEO_LISTEN = String(command.getOptionValue("listen"));
  if (givenOnCli("webUi")) {
    launchEnv.PASEO_WEB_UI_ENABLED = String(command.getOptionValue("webUi") === true);
  }
  return { foreground, launchEnv };
}
