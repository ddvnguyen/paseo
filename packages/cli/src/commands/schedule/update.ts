import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  createScheduleInspectRows,
  createScheduleInspectSchema,
  type ScheduleInspectRow,
} from "./schema.js";
import {
  connectScheduleClient,
  parseScheduleUpdateInput,
  requireNewAgentSchedule,
  toScheduleCommandError,
  type ScheduleCommandOptions,
} from "./shared.js";

export interface ScheduleUpdateOptions extends ScheduleCommandOptions {
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  mode?: string;
  cwd?: string;
  /**
   * `--workspace-id <id>` sets the id; `--no-workspace-id` sets it to false, so the
   * two share one key. Commander negates `--no-x` onto `x` itself — it never
   * produces a separate `noX` field, so reading `options.noWorkspaceId` would be
   * permanently undefined and the clear flag would silently do nothing.
   */
  workspaceId?: string | false;
  maxRuns?: string | false;
  noMaxRuns?: boolean;
  expiresIn?: string | false;
  noExpiresIn?: boolean;
}

export async function runUpdateCommand(
  id: string,
  options: ScheduleUpdateOptions,
  _command: Command,
): Promise<ListResult<ScheduleInspectRow>> {
  const input = parseScheduleUpdateInput({
    id,
    every: options.every,
    cron: options.cron,
    timezone: options.timezone,
    name: options.name,
    prompt: options.prompt,
    provider: options.provider,
    model: options.model,
    mode: options.mode,
    cwd: options.cwd,
    workspaceId: typeof options.workspaceId === "string" ? options.workspaceId : undefined,
    clearWorkspaceId: options.workspaceId === false,
    maxRuns: typeof options.maxRuns === "string" ? options.maxRuns : undefined,
    expiresIn: typeof options.expiresIn === "string" ? options.expiresIn : undefined,
    clearMaxRuns: options.maxRuns === false || options.noMaxRuns === true,
    clearExpires: options.expiresIn === false || options.noExpiresIn === true,
  });
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    await requireNewAgentSchedule(client, id);
    const payload = await client.scheduleUpdate(input);
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? `Failed to update schedule: ${id}`);
    }
    return {
      type: "list",
      data: createScheduleInspectRows(payload.schedule),
      schema: createScheduleInspectSchema(payload.schedule),
    };
  } catch (error) {
    throw toScheduleCommandError("SCHEDULE_UPDATE_FAILED", "update schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
