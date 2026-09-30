import { beforeEach, describe, expect, test, vi } from "vitest";

import type { Command } from "commander";

import type { CreateScheduleInput, ScheduleRecord, UpdateScheduleInput } from "./types.js";

const scheduleCreate = vi.fn();
const scheduleUpdate = vi.fn();
const scheduleInspect = vi.fn();
const close = vi.fn();

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    connectScheduleClient: async () => ({
      client: { scheduleCreate, scheduleUpdate, scheduleInspect, close },
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
    scheduleInspect.mockReset();
    scheduleInspect.mockResolvedValue({ schedule: SCHEDULE, error: null });
    close.mockReset();
    close.mockResolvedValue(undefined);
  });

  test("--workspace-id reaches the daemon with archiveOnFinish false", async () => {
    const input = await runUpdateArgv(["sch_1", "--workspace-id", "wks_shared"]);
    expect(input.newAgentConfig).toEqual({ workspaceId: "wks_shared", archiveOnFinish: false });
  });

  test("--no-workspace-id clears reuse", async () => {
    // Commander stores `--no-x` on `x` itself as false; it never populates a
    // separate `noX` key, so this is the only place the clear flag can be read.
    const input = await runUpdateArgv(["sch_1", "--no-workspace-id"]);
    expect(input.newAgentConfig).toEqual({ workspaceId: null });
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
});
