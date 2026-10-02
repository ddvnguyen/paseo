import type { Command } from "commander";
import type { SingleResult } from "../../output/index.js";
import { scheduleSchema } from "./schema.js";
import {
  assertNewAgentConfigApplied,
  connectScheduleClient,
  parseScheduleCreateInput,
  toScheduleCommandError,
  toScheduleRow,
  warnOnSharedWorkspace,
  type ScheduleCommandOptions,
  type ScheduleRow,
} from "./shared.js";

export interface ScheduleCreateOptions extends ScheduleCommandOptions {
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  target?: string;
  provider?: string;
  mode?: string;
  thinking?: string;
  cwd?: string;
  /** Reuse this existing workspace for every run instead of provisioning one. */
  workspaceId?: string;
  maxRuns?: string;
  expiresIn?: string;
  runNow?: boolean;
}

export async function runCreateCommand(
  prompt: string,
  options: ScheduleCreateOptions,
  command: Command,
): Promise<SingleResult<ScheduleRow>> {
  const runNowSource = command.getOptionValueSource("runNow");
  const runNow = runNowSource === "cli" ? Boolean(options.runNow) : undefined;
  const input = parseScheduleCreateInput({
    prompt,
    every: options.every,
    cron: options.cron,
    timezone: options.timezone,
    name: options.name,
    target: options.target,
    provider: options.provider,
    mode: options.mode,
    thinking: options.thinking,
    cwd: options.cwd,
    daemonTarget: options.daemonTarget,
    workspaceId: options.workspaceId,
    maxRuns: options.maxRuns,
    expiresIn: options.expiresIn,
    runNow,
  });
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    await warnOnSharedWorkspace(
      client,
      input.target.type === "new-agent" ? input.target.config.workspaceId : undefined,
    );
    const payload = await client.scheduleCreate(input);
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? "Schedule creation failed");
    }
    // A create request carries the whole new-agent config, so a daemon that predates
    // a field strips it the same way an update does. The stored schedule is the only
    // place that shows whether the flag actually took.
    if (input.target.type === "new-agent") {
      assertNewAgentConfigApplied(payload.schedule, input.target.config, {
        failureCode: "SCHEDULE_CREATE_FAILED",
        failureMessage: "Schedule was not created as a new-agent schedule",
      });
    }
    return {
      type: "single",
      data: toScheduleRow(payload.schedule),
      schema: scheduleSchema,
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_CREATE_FAILED", "create schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
