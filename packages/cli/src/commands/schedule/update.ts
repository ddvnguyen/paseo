import type { Command } from "commander";
import type { CommandError, ListResult } from "../../output/index.js";
import {
  createScheduleInspectRows,
  createScheduleInspectSchema,
  type ScheduleInspectRow,
} from "./schema.js";
import {
  assertDaemonSupportsWorkspaceReuseClear,
  assertNewAgentConfigApplied,
  connectScheduleClient,
  isWorkspaceReuseClearRejection,
  parseScheduleUpdateInput,
  requireNewAgentSchedule,
  toScheduleCommandError,
  warnOnSharedWorkspace,
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
  /**
   * `--name-run-conversations` and `--no-name-run-conversations` share this key.
   * Commander folds a `--no-x` onto `x` itself, so there is no separate
   * `noNameRunConversations` to read. `getOptionValueSource` is what separates
   * "not passed" from "passed as false" — without it the flag defaults to true and
   * every schedule update would switch naming on by accident.
   */
  nameRunConversations?: boolean;
  maxRuns?: string | false;
  noMaxRuns?: boolean;
  expiresIn?: string | false;
  noExpiresIn?: boolean;
}

export async function runUpdateCommand(
  id: string,
  options: ScheduleUpdateOptions,
  command: Command,
): Promise<ListResult<ScheduleInspectRow>> {
  // "cli" is the only source that means the user typed the flag. Anything else is
  // Commander's own default, which for a positive/negative pair is a value, not an
  // absence — reading options.nameRunConversations directly would turn naming on
  // for every update that did not mention it.
  const nameRunConversationsSource = command.getOptionValueSource("nameRunConversations");
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
    nameRunConversations:
      nameRunConversationsSource === "cli" && options.nameRunConversations === true
        ? true
        : undefined,
    clearNameRunConversations:
      nameRunConversationsSource === "cli" && options.nameRunConversations === false,
    maxRuns: typeof options.maxRuns === "string" ? options.maxRuns : undefined,
    expiresIn: typeof options.expiresIn === "string" ? options.expiresIn : undefined,
    clearMaxRuns: options.maxRuns === false || options.noMaxRuns === true,
    clearExpires: options.expiresIn === false || options.noExpiresIn === true,
  });
  const { client } = await connectScheduleClient(options.daemonTarget);
  try {
    await requireNewAgentSchedule(client, id);
    // COMPAT(scheduleWorkspaceReuseClear): added in v0.8.0, remove after 2027-09-30.
    // Only the clear is gated. Setting an id is a plain string and every daemon that
    // has schedules understands it.
    if (input.newAgentConfig?.workspaceId === null) {
      assertDaemonSupportsWorkspaceReuseClear(client);
    }
    await warnOnSharedWorkspace(client, input.newAgentConfig?.workspaceId ?? undefined, id);
    const payload = await client.scheduleUpdate(input);
    if (payload.error || !payload.schedule) {
      throw new Error(payload.error ?? `Failed to update schedule: ${id}`);
    }
    // The daemon answers with the schedule it actually stored. Reading the fields
    // back is what turns "this daemon does not know that key" from a silent no-op
    // into a failure naming the flag.
    assertNewAgentConfigApplied(payload.schedule, input.newAgentConfig);
    return {
      type: "list",
      data: createScheduleInspectRows(payload.schedule),
      schema: createScheduleInspectSchema(payload.schedule),
    };
  } catch (error) {
    // COMPAT(scheduleWorkspaceReuseClear): added in v0.8.0, remove after 2027-09-30.
    // A daemon too old to read the clear says so as a schema error; name the flag.
    if (input.newAgentConfig?.workspaceId === null && isWorkspaceReuseClearRejection(error)) {
      throw {
        code: "DAEMON_TOO_OLD",
        message:
          "This daemon is too old to clear workspace reuse. Update the Paseo daemon, then retry.",
      } satisfies CommandError;
    }
    throw toScheduleCommandError("SCHEDULE_UPDATE_FAILED", "update schedule", error);
  } finally {
    await client.close().catch(() => {});
  }
}
