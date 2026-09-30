import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Command } from "commander";

import type { CreateScheduleInput, ScheduleRecord, UpdateScheduleInput } from "./types.js";

const scheduleCreate = vi.fn();
const scheduleUpdate = vi.fn();
const scheduleInspect = vi.fn();
const scheduleList = vi.fn();
const close = vi.fn();
let serverInfo: { features?: Record<string, boolean> } | null = null;

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    connectScheduleClient: async () => ({
      client: {
        scheduleCreate,
        scheduleUpdate,
        scheduleInspect,
        scheduleList,
        close,
        getLastServerInfoMessage: () => serverInfo,
      },
      host: "test",
    }),
  };
});

const { createScheduleCommand } = await import("./index.js");
const SCHEDULE: ScheduleRecord = {
  id: "sch_1",
  name: null,
  prompt: "do the thing",
  cadence: { type: "cron", expression: "*/5 * * * *" },
  target: { type: "new-agent", config: { provider: "claude", cwd: "/repo" } },
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  pausedAt: null,
  expiresAt: null,
  maxRuns: null,
  runs: [],
} as ScheduleRecord;

function subcommand(name: string): Command {
  const command = createScheduleCommand();
  const found = command.commands.find((sub) => sub.name() === name);
  if (!found) throw new Error(`schedule ${name} command is not registered`);
  return found;
}

async function runUpdateArgv(argv: string[]): Promise<UpdateScheduleInput> {
  // Commander resolves the action handler off the subcommand, so exercise the real
  // flag definitions rather than calling the parser with a hand-built object.
  await subcommand("update").parseAsync(argv, { from: "user" });
  return scheduleUpdate.mock.calls[0]![0] as UpdateScheduleInput;
}

async function runCreateArgv(argv: string[]): Promise<CreateScheduleInput> {
  await subcommand("create").parseAsync(argv, { from: "user" });
  return scheduleCreate.mock.calls[0]![0] as CreateScheduleInput;
}

function captureStderr() {
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as unknown as typeof process.stderr.write);
  return {
    join: () => spy.mock.calls.map((call) => String(call[0])).join(""),
    restore: () => spy.mockRestore(),
  };
}

/** Run a command that is expected to fail, capturing what the user is told. */
async function runUpdateExpectingExit(argv: string[], expected?: RegExp): Promise<string> {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  const stderr = captureStderr();
  try {
    await expect(subcommand("update").parseAsync(argv, { from: "user" })).rejects.toThrow(
      "process.exit",
    );
    expect(exit).toHaveBeenCalledWith(1);
    if (expected) expect(stderr.join()).toMatch(expected);
    return stderr.join();
  } finally {
    exit.mockRestore();
    stderr.restore();
  }
}

describe("schedule create workspace flags through commander", () => {
  beforeEach(() => {
    scheduleCreate.mockReset();
    scheduleCreate.mockResolvedValue({ schedule: SCHEDULE, error: null });
    close.mockReset();
    close.mockResolvedValue(undefined);
  });

  test("--workspace-id reaches the daemon and pins archiveOnFinish false", async () => {
    // The flag was declared on the command but never forwarded out of the action
    // handler, so it was dropped before parsing. Only driving the real Commander
    // definitions catches that.
    const input = await runCreateArgv([
      "do the thing",
      "--every",
      "5m",
      "--provider",
      "claude",
      "--workspace-id",
      "wks_shared",
    ]);
    const target = input.target as { type: string; config: Record<string, unknown> };
    expect(target.type).toBe("new-agent");
    expect(target.config.workspaceId).toBe("wks_shared");
    expect(target.config.archiveOnFinish).toBe(false);
  });

  test("omitting --workspace-id provisions a workspace per run", async () => {
    const input = await runCreateArgv(["do the thing", "--every", "5m", "--provider", "claude"]);
    const target = input.target as { type: string; config: Record<string, unknown> };
    expect(target.config.workspaceId).toBeUndefined();
    expect(target.config.archiveOnFinish).toBeUndefined();
  });
});

describe("schedule update workspace flags through commander", () => {
  beforeEach(() => {
    scheduleUpdate.mockReset();
    scheduleUpdate.mockResolvedValue({ schedule: SCHEDULE, error: null });
    scheduleCreate.mockReset();
    scheduleCreate.mockResolvedValue({ schedule: SCHEDULE, error: null });
    scheduleInspect.mockReset();
    scheduleInspect.mockResolvedValue({ schedule: SCHEDULE, error: null });
    scheduleList.mockReset();
    scheduleList.mockResolvedValue({ schedules: [], error: null });
    close.mockReset();
    close.mockResolvedValue(undefined);
    serverInfo = { features: { scheduleWorkspaceReuseClear: true } };
  });

  test("--workspace-id reaches the daemon with archiveOnFinish false", async () => {
    const input = await runUpdateArgv(["sch_1", "--workspace-id", "wks_shared"]);
    expect(input.newAgentConfig).toEqual({ workspaceId: "wks_shared", archiveOnFinish: false });
  });

  test("--no-workspace-id clears reuse and restores archiving", async () => {
    // Commander stores `--no-x` on `x` itself as false; it never populates a
    // separate `noX` key, so this is the only place the clear flag can be read.
    const input = await runUpdateArgv(["sch_1", "--no-workspace-id"]);
    // archiveOnFinish comes back too, or every later run leaks a workspace.
    expect(input.newAgentConfig).toEqual({ workspaceId: null, archiveOnFinish: true });
  });

  test("--no-max-runs clears the limit", async () => {
    const input = await runUpdateArgv(["sch_1", "--no-max-runs"]);
    expect(input.maxRuns).toBeNull();
  });

  test("--no-expires-in clears the expiry", async () => {
    const input = await runUpdateArgv(["sch_1", "--no-expires-in"]);
    expect(input.expiresAt).toBeNull();
  });

  test("an empty --workspace-id is rejected before the daemon is called", async () => {
    // withOutput turns a CommandError into a rendered message plus exit(1), so the
    // assertion is on the exit and on the daemon never being asked to update.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as unknown as typeof process.stderr.write);
    try {
      const command = createScheduleCommand();
      const update = command.commands.find((sub) => sub.name() === "update") as Command;
      await expect(
        update.parseAsync(["sch_1", "--workspace-id", "  "], { from: "user" }),
      ).rejects.toThrow("process.exit");
      expect(exit).toHaveBeenCalledWith(1);
      expect(stderr.mock.calls.join("")).toContain("--workspace-id cannot be empty");
      expect(scheduleUpdate).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      stderr.mockRestore();
    }
  });

  // COMPAT(scheduleWorkspaceReuseClear): added in v0.8.0, remove after 2027-09-30.
  describe("--no-workspace-clear capability gate", () => {
    test("a daemon without the capability never receives the null clear", async () => {
      serverInfo = { features: { workspaceSetupRun: true } };
      await runUpdateExpectingExit(["sch_1", "--no-workspace-id"]);
      // The raw failure is a Zod "expected string, received null" that names no flag,
      // so the request must not be sent at all.
      expect(scheduleUpdate).not.toHaveBeenCalled();
    });

    test("a capable daemon receives the null clear", async () => {
      serverInfo = { features: { scheduleWorkspaceReuseClear: true } };
      const input = await runUpdateArgv(["sch_1", "--no-workspace-id"]);
      expect(input.newAgentConfig).toEqual({ workspaceId: null, archiveOnFinish: true });
    });

    test("an unknown daemon is allowed through and a rejection is explained", async () => {
      // No server_info yet: the CLI cannot rule the daemon out, so it sends the
      // request and translates whatever comes back.
      serverInfo = null;
      scheduleUpdate.mockRejectedValueOnce(
        new Error("invalid_message: expected string, received null at target.config.workspaceId"),
      );
      const output = await runUpdateExpectingExit(["sch_1", "--no-workspace-id"]);
      expect(scheduleUpdate).toHaveBeenCalledTimes(1);
      // The raw message names no flag, so the user would not know what to change.
      expect(output).toContain("too old to clear workspace reuse");
      expect(output).not.toContain("expected string, received null");
    });

    test("an unrelated update failure is not reported as a version problem", async () => {
      serverInfo = null;
      scheduleUpdate.mockResolvedValueOnce({ schedule: null, error: "Schedule not found" });
      await runUpdateExpectingExit(["sch_1", "--no-workspace-id"], /Schedule not found/);
    });

    test("setting an id is never gated — every daemon with schedules reads a string", async () => {
      serverInfo = { features: {} };
      const input = await runUpdateArgv(["sch_1", "--workspace-id", "wks_shared"]);
      expect(input.newAgentConfig).toEqual({ workspaceId: "wks_shared", archiveOnFinish: false });
    });
  });

  describe("shared workspace warning", () => {
    const sharingSchedule = (id: string, workspaceId?: string) => ({
      id,
      target: {
        type: "new-agent" as const,
        config: { provider: "claude", cwd: "/r", workspaceId },
      },
    });

    test("create warns when another schedule already names the workspace", async () => {
      serverInfo = { features: { scheduleWorkspaceReuseClear: true } };
      scheduleList.mockResolvedValue({
        schedules: [sharingSchedule("sch_other", "wks_shared")],
        error: null,
      });
      const stderr = captureStderr();
      try {
        await subcommand("create").parseAsync(
          ["do the thing", "--every", "5m", "--provider", "claude", "--workspace-id", "wks_shared"],
          { from: "user" },
        );
        expect(stderr.join("")).toContain("wks_shared");
        expect(stderr.join("")).toContain("not serialised");
      } finally {
        stderr.restore();
      }
      // Advisory only: the schedule is still created.
      expect(scheduleCreate).toHaveBeenCalledTimes(1);
    });

    test("update does not warn about the schedule being updated", async () => {
      serverInfo = { features: { scheduleWorkspaceReuseClear: true } };
      scheduleList.mockResolvedValue({
        schedules: [sharingSchedule("sch_1", "wks_shared")],
        error: null,
      });
      const stderr = captureStderr();
      try {
        await subcommand("update").parseAsync(["sch_1", "--workspace-id", "wks_shared"], {
          from: "user",
        });
        expect(stderr.join("")).toBe("");
      } finally {
        stderr.restore();
      }
    });

    test("clearing reuse does not warn about sharing", async () => {
      // There is no shared workspace left to collide with, so a warning here would
      // be noise on the one operation that fixes the problem.
      serverInfo = { features: { scheduleWorkspaceReuseClear: true } };
      scheduleList.mockResolvedValue({
        schedules: [sharingSchedule("sch_other", "wks_shared")],
        error: null,
      });
      const stderr = captureStderr();
      try {
        await subcommand("update").parseAsync(["sch_1", "--no-workspace-id"], { from: "user" });
        expect(stderr.join("")).toBe("");
      } finally {
        stderr.restore();
      }
    });

    test("a failed list never blocks the update", async () => {
      serverInfo = { features: { scheduleWorkspaceReuseClear: true } };
      scheduleList.mockRejectedValue(new Error("list unavailable"));
      const input = await runUpdateArgv(["sch_1", "--workspace-id", "wks_shared"]);
      expect(input.newAgentConfig).toEqual({ workspaceId: "wks_shared", archiveOnFinish: false });
    });
  });
});
