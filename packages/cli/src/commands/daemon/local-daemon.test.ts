import { Command } from "commander";
import { describe, expect, test } from "vitest";
import { readLegacyDaemonStartFlags } from "./local-daemon.js";
import { daemonRunCommand, startCommand } from "./start.js";
import { daemonRestartCommand } from "./restart.js";

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
});
