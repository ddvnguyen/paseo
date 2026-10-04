import { Command } from "commander";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CommandOptions } from "../../output/index.js";

const launchLocalDaemon = vi.fn(async () => ({
  spawned: true,
  instance: { pid: 4242, listen: "0.0.0.0:6767" },
  exitCode: 0,
}));

vi.mock("./local-daemon.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./local-daemon.js")>()),
  launchLocalDaemon,
}));

const { readLegacyDaemonStartFlags } = await import("./local-daemon.js");
const { daemonRunCommand, runStart, startCommand } = await import("./start.js");
const { daemonRestartCommand } = await import("./restart.js");

// The real command wiring, not a hand-built one: `daemon start` registers these
// flags twice over (once as removed, once as legacy-accepted) and commander throws
// on the duplicate. Building the command here keeps that wiring covered.
//
// parseOptions, not parse. parse() runs the action, which would try to launch a
// daemon against the real PASEO_HOME.
function parse(command: Command, argv: string[]) {
  command.parseOptions(argv);
  return command;
}

function read(argv: string[]) {
  return readLegacyDaemonStartFlags(parse(startCommand(), argv));
}

// deploy/systemd/paseo.service and paseo-test.service ExecStart, verbatim.
const PROD_UNIT_ARGV = ["--foreground", "--listen", "0.0.0.0:6767", "--no-web-ui"];

describe("legacy daemon start flags", () => {
  test("maps the checked-in systemd ExecStart onto a foreground deployment launch", () => {
    expect(read(PROD_UNIT_ARGV)).toEqual({
      foreground: true,
      launchEnv: { PASEO_LISTEN: "0.0.0.0:6767", PASEO_WEB_UI_ENABLED: "false" },
    });
  });

  test("keeps a plain start a managed launch with an untouched environment", () => {
    expect(read([])).toEqual({ foreground: false, launchEnv: {} });
  });

  test("carries only the flags that were actually passed", () => {
    expect(read(["--foreground", "--listen", "0.0.0.0:6868"])).toEqual({
      foreground: true,
      launchEnv: { PASEO_LISTEN: "0.0.0.0:6868" },
    });
  });

  test("overrides an inherited environment value rather than deferring to it", () => {
    // paseo-bun exports PASEO_LISTEN before the CLI runs, so the flag has to win.
    const command = parse(startCommand(), ["--foreground", "--listen", "0.0.0.0:6767"]);

    expect(readLegacyDaemonStartFlags(command).launchEnv.PASEO_LISTEN).toBe("0.0.0.0:6767");
  });

  test.each([
    [["--listen", "0.0.0.0:6767"]],
    [["--no-web-ui"]],
    [["--listen", "0.0.0.0:6767", "--no-web-ui"]],
  ])("refuses %j on a managed launch rather than silently ignoring it", (argv) => {
    expect(() => read(argv)).toThrowError(
      expect.objectContaining({ code: "REMOVED_LAUNCH_OPTION" }),
    );
  });

  test("stays out of the help output", () => {
    const help = startCommand().helpInformation();

    expect(help).not.toContain("--foreground");
    expect(help).not.toContain("--listen");
    expect(help).not.toContain("--no-web-ui");
  });

  test.each([
    ["run", () => daemonRunCommand()],
    ["restart", () => daemonRestartCommand()],
  ])("leaves the legacy flags rejected on `daemon %s`", (_name, build) => {
    const command = build();

    expect(command.options.some((option) => option.long === "--foreground")).toBe(true);
    expect(command.options.some((option) => option.long === "--listen")).toBe(true);
  });

  // The tests above only prove the pure mapper works. They read the flags off a
  // command where `rejectRemovedLaunchFlags` happens to have registered them as
  // hidden "removed" options, so they pass whether or not `startCommand` wires the
  // mapper into the launch at all. These two drive the wiring itself.
  describe("startCommand wiring", () => {
    beforeEach(() => {
      launchLocalDaemon.mockClear();
      process.exitCode = undefined;
    });

    const START_OPTIONS = {
      daemonTarget: { kind: "instance", home: "/scratch/paseo-home" },
    } satisfies CommandOptions;

    test("runStart forwards the unit's flags to the launch instead of dropping them", async () => {
      const command = parse(startCommand(), PROD_UNIT_ARGV);

      await runStart(START_OPTIONS, command);

      expect(launchLocalDaemon).toHaveBeenCalledWith(
        expect.objectContaining({
          home: "/scratch/paseo-home",
          foreground: true,
          launchEnv: { PASEO_LISTEN: "0.0.0.0:6767", PASEO_WEB_UI_ENABLED: "false" },
        }),
      );
    });

    test("runStart keeps a plain start a managed launch", async () => {
      const command = parse(startCommand(), []);

      await runStart(START_OPTIONS, command);

      expect(launchLocalDaemon).toHaveBeenCalledWith(
        expect.objectContaining({ foreground: false, launchEnv: {} }),
      );
    });

    // The PROD crash: with the legacy flags still registered as removed, the
    // preAction hook throws REMOVED_LAUNCH_OPTION and the unit crash-loops.
    test("does not reject the unit's flags on the way to the action", async () => {
      await expect(
        startCommand().parseAsync(["node", "paseo", ...PROD_UNIT_ARGV]),
      ).resolves.toBeDefined();

      expect(launchLocalDaemon).toHaveBeenCalledWith(expect.objectContaining({ foreground: true }));
    });

    test("a foreground launch owns the exit code systemd reads", async () => {
      const command = parse(startCommand(), PROD_UNIT_ARGV);

      await runStart(START_OPTIONS, command);

      expect(process.exitCode).toBe(0);
    });
  });
});
