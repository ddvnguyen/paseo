import { addLocalDaemonOptions } from "../../utils/command-options.js";
import { Command } from "commander";
import { daemonLogPath } from "@getpaseo/server/daemon-control";
import {
  addLegacyDaemonStartFlags,
  launchLocalDaemon,
  parseTimeoutMs,
  readLegacyDaemonStartFlags,
  rejectRemovedLaunchFlags,
} from "./local-daemon.js";
import { withOutput, type CommandOptions } from "../../output/index.js";

// COMPAT(daemon-start-flags): added in v0.9.3, remove after 2027-02-01. Rationale
// in local-daemon.ts. Only `start` opts in; `run` and `restart` keep rejecting.
export function startCommand(): Command {
  return addLegacyDaemonStartFlags(
    rejectRemovedLaunchFlags(addLocalDaemonOptions(new Command("start")), {
      allowLegacyStartFlags: true,
    }),
  )
    .description("Start the local daemon from persistent configuration (local operation)")
    .option("--timeout <seconds>", "Readiness deadline (default: 600)")
    .action(withOutput(runStart));
}

export async function runStart(options: CommandOptions, command: Command) {
  if (options.daemonTarget.kind !== "instance") throw new Error("Start requires a local home");
  const home = options.daemonTarget.home;
  // The systemd units pass deployment flags to `daemon start`. They change how this
  // launch is wired, never the home.
  const legacy = readLegacyDaemonStartFlags(command);
  const result = await launchLocalDaemon({
    home,
    timeoutMs: parseTimeoutMs(options.timeout),
    foreground: legacy.foreground,
    launchEnv: legacy.launchEnv,
  });
  if (legacy.foreground) {
    // This process is the unit's main process, so its exit status is what systemd
    // reads for Restart=on-failure.
    process.exitCode = result.exitCode ?? 0;
  }
  const data = {
    action: result.spawned ? "started" : "already_running",
    home,
    pid: result.instance.pid,
    listen: result.instance.listen,
    logPath: daemonLogPath(home),
  };
  return {
    type: "single" as const,
    data,
    schema: {
      idField: "pid" as const,
      columns: [],
      renderHuman: () =>
        `${result.spawned ? "Started" : "Already running"}: PID ${data.pid}${data.listen ? `, listening on ${data.listen}` : ", not ready"}\nLogs: ${data.logPath}`,
    },
  };
}

export function daemonRunCommand(): Command {
  return rejectRemovedLaunchFlags(addLocalDaemonOptions(new Command("run")))
    .description("Run a local daemon in the foreground with deployment environment overrides")
    .action(
      withOutput(async (options: CommandOptions, _command: Command) => {
        if (options.daemonTarget.kind !== "instance") throw new Error("Run requires a local home");
        const result = await launchLocalDaemon({
          home: options.daemonTarget.home,
          foreground: true,
        });
        process.exitCode = result.exitCode ?? 0;
        return {
          type: "single" as const,
          data: { pid: result.instance.pid, action: result.spawned ? "exited" : "already_running" },
          schema: { idField: "pid" as const, columns: [] },
        };
      }),
    );
}
