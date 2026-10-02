import type { DaemonTarget } from "../../utils/daemon-target.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions } from "../../output/index.js";
import type {
  CreateScheduleInput,
  ScheduleCadence,
  ScheduleDaemonClient,
  ScheduleListItem,
  ScheduleRecord,
  ScheduleTarget,
  UpdateScheduleInput,
  UpdateScheduleNewAgentConfig,
} from "./types.js";
import { parseDuration } from "../../utils/duration.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";
import { everyMsToFiveFieldCron } from "@getpaseo/protocol/schedule/cadence";

export interface ScheduleCommandOptions extends CommandOptions {
  host?: string;
}

export async function connectScheduleClient(
  target: DaemonTarget,
): Promise<{ client: ScheduleDaemonClient; host: string }> {
  const resolvedHost = getDaemonHost({ target });
  try {
    const client = (await connectToDaemon({
      target,
    })) as unknown as ScheduleDaemonClient;
    return { client, host: resolvedHost };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${resolvedHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export function toScheduleCommandError(code: string, action: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code,
    message: `Failed to ${action}: ${message}`,
  };
}

/**
 * Refuse to send a workspace-reuse clear to a daemon that cannot read it.
 *
 * Clearing reuse is a `null` in `newAgentConfig.workspaceId`. A daemon that predates
 * the field rejects the whole update with a Zod message ("expected string, received
 * null") that says nothing about which flag caused it, so the user would see a
 * schema error for something they typed as `--no-workspace-id`. The capability check
 * happens here, once, before the request goes out.
 *
 * COMPAT(scheduleWorkspaceReuseClear): added in v0.8.0, remove after 2027-09-30.
 */
export function assertDaemonSupportsWorkspaceReuseClear(client: ScheduleDaemonClient): void {
  const features = client.getLastServerInfoMessage?.()?.features;
  // A client that has not seen server_info yet cannot rule the daemon out, so the
  // request goes out and the daemon has the final say.
  if (!features) return;
  if (features.scheduleWorkspaceReuseClear === true) return;
  throw {
    code: "DAEMON_TOO_OLD",
    message:
      "This daemon is too old to clear workspace reuse. Update the Paseo daemon, then retry.",
  } satisfies CommandError;
}

/**
 * Translate a daemon that rejected the null clear anyway. Reached when server_info
 * had not arrived, so the capability check could not rule the daemon out first.
 *
 * COMPAT(scheduleWorkspaceReuseClear): added in v0.8.0, remove after 2027-09-30.
 */
export function isWorkspaceReuseClearRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("workspaceId") && /expected string, received null|received null/.test(message)
  );
}

/**
 * Fail when the daemon's answer does not show a field the command just set.
 *
 * A wire schema is a Zod object, and a Zod object silently STRIPS keys it does not
 * declare. So a daemon built before a field joined the schedule schemas accepts the
 * whole request, drops that one key, applies the rest, and answers with a schedule
 * that never had it — no error anywhere. `--workspace-id` against such a daemon
 * reported the schedule as configured and changed nothing; the collector's runs went
 * on provisioning a workspace apiece, which is the exact behaviour the flag exists to
 * stop.
 *
 * A capability flag cannot close this on its own: it only covers fields someone
 * remembered to gate, and it cannot be consulted before `server_info` has arrived.
 * Reading the daemon's own answer back needs neither, and covers any field the
 * protocol grows later.
 */
export function assertNewAgentConfigApplied(
  // `schedule/create` answers with a summary and `schedule/update` with the full
  // record; both carry the target, which is all this reads.
  schedule: { target: ScheduleTarget | ScheduleListItem["target"] },
  requested: NewAgentConfigFields | undefined,
  options?: { failureCode?: string; failureMessage?: string },
): void {
  if (!requested) return;
  const config = schedule.target.type === "new-agent" ? schedule.target.config : null;
  if (!config) {
    throw {
      code: options?.failureCode ?? "SCHEDULE_UPDATE_FAILED",
      message:
        options?.failureMessage ??
        "Schedule is no longer a new-agent schedule, so its configuration was not applied",
    } satisfies CommandError;
  }
  const dropped = droppedConfigFields(config, requested);
  if (dropped.length === 0) return;
  throw {
    code: "DAEMON_TOO_OLD",
    message:
      `This daemon ignored ${dropped.join(", ")} and reported success. ` +
      "It is too old to store them. Update the Paseo daemon, then retry.",
  } satisfies CommandError;
}

/** The new-agent config fields the CLI can set, and which a stale daemon may drop. */
export interface NewAgentConfigFields {
  workspaceId?: string | null;
}

/**
 * Which of the fields this request set are absent from the schedule the daemon
 * returned. A clear is encoded as `null` and must land as an absent field, so both
 * directions are compared as "equals what was asked for".
 */
function droppedConfigFields(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
  requested: NewAgentConfigFields,
): string[] {
  const dropped: string[] = [];
  for (const [field, flag] of [["workspaceId", "workspace-id"]] as const) {
    const asked = requested[field];
    if (asked === undefined) continue;
    const applied = asked === null ? undefined : asked;
    if (config[field] === applied) continue;
    dropped.push(`--${asked === null ? "no-" : ""}${flag}`);
  }
  return dropped;
}

/**
 * Warn when another schedule already names the same workspace. Two schedules sharing
 * one workspace run concurrently with no exclusion, so their agents can interleave in
 * the same directory. Best effort: a list failure is not worth failing the command
 * over, and the daemon does not serialise runs across schedules.
 */
export async function warnOnSharedWorkspace(
  client: ScheduleDaemonClient,
  workspaceId: string | undefined,
  currentScheduleId?: string,
): Promise<void> {
  if (!workspaceId) return;
  try {
    const payload = await client.scheduleList();
    if (payload.error || !payload.schedules) return;
    const sharing = payload.schedules.filter(
      (schedule) =>
        schedule.id !== currentScheduleId &&
        schedule.target.type === "new-agent" &&
        schedule.target.config.workspaceId === workspaceId,
    );
    if (sharing.length === 0) return;
    process.stderr.write(
      `Warning: ${sharing.length} other schedule(s) already use workspace ${workspaceId}. ` +
        `Their runs are not serialised against yours and can interleave in the same directory.\n`,
    );
  } catch {
    // Advisory only. Never block a schedule change on a failed best-effort check.
  }
}

export async function requireNewAgentSchedule(
  client: ScheduleDaemonClient,
  id: string,
): Promise<void> {
  const payload = await client.scheduleInspect({ id });
  if (payload.error || !payload.schedule || payload.schedule.target.type !== "new-agent") {
    throw new Error(payload.error ?? `Schedule not found: ${id}`);
  }
}

export function formatCadence(cadence: ScheduleCadence): string {
  if (cadence.type === "cron") {
    const timezoneSuffix = cadence.timezone ? ` (${cadence.timezone})` : "";
    return `cron:${cadence.expression}${timezoneSuffix}`;
  }
  return `every:${formatDurationMs(cadence.everyMs)}`;
}

export function formatTarget(target: ScheduleTarget | ScheduleListItem["target"]): string {
  if (target.type === "self") {
    return `self:${target.agentId.slice(0, 7)}`;
  }
  if (target.type === "agent") {
    return `agent:${target.agentId.slice(0, 7)}`;
  }
  const modelSuffix = target.config.model ? `/${target.config.model}` : "";
  return `new-agent:${target.config.provider}${modelSuffix}`;
}

export function formatDurationMs(durationMs: number): string {
  const parts: string[] = [];
  let remainingMs = durationMs;
  const hours = Math.floor(remainingMs / (60 * 60 * 1000));
  if (hours > 0) {
    parts.push(`${hours}h`);
    remainingMs -= hours * 60 * 60 * 1000;
  }
  const minutes = Math.floor(remainingMs / (60 * 1000));
  if (minutes > 0) {
    parts.push(`${minutes}m`);
    remainingMs -= minutes * 60 * 1000;
  }
  const seconds = Math.floor(remainingMs / 1000);
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  return parts.join("");
}

function resolveScheduleTarget(args: {
  targetValue: string | undefined;
  hasExplicitNewAgentOption: boolean;
  createNewAgentTarget: () => ScheduleTarget;
}): ScheduleTarget {
  const { targetValue, hasExplicitNewAgentOption, createNewAgentTarget } = args;
  if (!targetValue) {
    return createNewAgentTarget();
  }

  if (targetValue === "new-agent") {
    return createNewAgentTarget();
  }

  if (hasExplicitNewAgentOption) {
    throw {
      code: "INVALID_TARGET",
      message: "--provider/--mode/--thinking can only be used with a new-agent target",
      details: "Use --target new-agent or omit --target to create a new agent schedule",
    } satisfies CommandError;
  }

  if (targetValue === "self") {
    // COMPAT(scheduleSelfTarget): heartbeat creation moved to `paseo heartbeat create`.
    // Added in v0.2.0; remove after 2027-01-17.
    const currentAgentId = process.env.PASEO_AGENT_ID?.trim();
    if (!currentAgentId) {
      throw {
        code: "INVALID_TARGET",
        message: "--target self requires running inside a Paseo agent",
      } satisfies CommandError;
    }
    return { type: "self", agentId: currentAgentId };
  }

  return { type: "agent", agentId: targetValue };
}

export function parseScheduleCreateInput(options: {
  prompt: string;
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  target?: string;
  provider?: string;
  mode?: string;
  thinking?: string;
  cwd?: string;
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  maxRuns?: string;
  workspaceId?: string;
  expiresIn?: string;
  runNow?: boolean;
}): CreateScheduleInput {
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw {
      code: "INVALID_PROMPT",
      message: "Schedule prompt cannot be empty",
    } satisfies CommandError;
  }

  const cadence = parseCadenceFromFlags(options.every, options.cron, options.timezone);
  if (!cadence) {
    throw {
      code: "INVALID_CADENCE",
      message: "Specify exactly one of --every or --cron",
    } satisfies CommandError;
  }

  const cwdInput = options.cwd?.trim();
  if (options.daemonTarget.kind === "endpoint" && !cwdInput) {
    throw {
      code: "MISSING_CWD",
      message:
        "--cwd is required when --host is specified (the local working directory will not exist on the remote daemon)",
    } satisfies CommandError;
  }

  const runOnCreate = resolveRunOnCreate(options.runNow, cadence.type);

  const targetValue = options.target?.trim();
  const modeId = options.mode?.trim();
  const thinkingOptionId = options.thinking?.trim();
  if (options.thinking !== undefined && !thinkingOptionId) {
    throw {
      code: "INVALID_THINKING_OPTION",
      message: "--thinking cannot be empty",
    } satisfies CommandError;
  }
  const hasExplicitNewAgentOption =
    options.provider !== undefined || options.mode !== undefined || options.thinking !== undefined;
  const createNewAgentTarget = (): ScheduleTarget => {
    const resolvedProviderModel = resolveProviderAndModel({
      provider: options.provider,
    });
    return {
      type: "new-agent",
      config: {
        provider: resolvedProviderModel.provider,
        cwd: cwdInput ?? process.cwd(),
        ...(resolvedProviderModel.model ? { model: resolvedProviderModel.model } : {}),
        ...(modeId ? { modeId } : {}),
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
        // Reuse is meaningless unless the workspace survives the run, so asking for
        // a workspaceId also pins archiveOnFinish false rather than refusing the
        // combination. The user asked for one workspace; archiving it per run would
        // silently give them a new one each time, which is the behaviour they were
        // trying to avoid. The daemon re-checks the pair on every run regardless.
        ...(options.workspaceId
          ? { workspaceId: parseWorkspaceId(options.workspaceId), archiveOnFinish: false }
          : {}),
      },
    };
  };
  const target = resolveScheduleTarget({
    targetValue,
    hasExplicitNewAgentOption,
    createNewAgentTarget,
  });

  const maxRuns =
    options.maxRuns === undefined ? undefined : parsePositiveInt(options.maxRuns, "--max-runs");
  const expiresAt =
    options.expiresIn === undefined
      ? undefined
      : new Date(Date.now() + parseDuration(options.expiresIn)).toISOString();

  return {
    prompt,
    cadence,
    target,
    runOnCreate,
    ...(options.name?.trim() ? { name: options.name.trim() } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function resolveRunOnCreate(
  runNow: boolean | undefined,
  _cadenceType: ScheduleCadence["type"],
): boolean {
  return runNow ?? false;
}

export interface ScheduleUpdateOptionsInput {
  id: string;
  every?: string;
  cron?: string;
  timezone?: string;
  name?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  mode?: string;
  cwd?: string;
  /** Reuse an existing workspace for every run; omit to keep per-run workspaces. */
  workspaceId?: string;
  /** Drop workspace reuse and go back to one workspace per run. */
  clearWorkspaceId?: boolean;
  maxRuns?: string;
  expiresIn?: string;
  clearMaxRuns?: boolean;
  clearExpires?: boolean;
}

export function parseScheduleUpdateInput(options: ScheduleUpdateOptionsInput): UpdateScheduleInput {
  const id = options.id.trim();
  if (!id) {
    throw {
      code: "INVALID_SCHEDULE_ID",
      message: "Schedule id cannot be empty",
    } satisfies CommandError;
  }

  const cadence = parseCadenceFromFlags(options.every, options.cron, options.timezone);
  const newAgentConfig = buildNewAgentConfigPatch(options);
  const maxRuns = parseUpdateMaxRuns(options);
  const expiresAt = parseUpdateExpiresAt(options);
  const name = parseUpdateName(options);
  const prompt = parseUpdatePrompt(options);

  if (
    name === undefined &&
    prompt === undefined &&
    cadence === undefined &&
    newAgentConfig === undefined &&
    maxRuns === undefined &&
    expiresAt === undefined
  ) {
    throw {
      code: "NO_UPDATES",
      message: "Specify at least one field to update",
    } satisfies CommandError;
  }

  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(cadence !== undefined ? { cadence } : {}),
    ...(newAgentConfig !== undefined ? { newAgentConfig } : {}),
    ...(maxRuns !== undefined ? { maxRuns } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function parseCadenceFromFlags(
  every: string | undefined,
  cron: string | undefined,
  timezone: string | undefined,
): ScheduleCadence | undefined {
  if (every !== undefined && cron !== undefined) {
    throw {
      code: "INVALID_CADENCE",
      message: "Specify at most one of --every or --cron",
    } satisfies CommandError;
  }
  const trimmedTimeZone = parseTimeZoneFlag(timezone);
  if (trimmedTimeZone !== undefined && cron === undefined) {
    throw {
      code: "INVALID_TIME_ZONE",
      message: "--timezone can only be used with --cron",
    } satisfies CommandError;
  }
  if (every !== undefined) {
    return { type: "cron", expression: compileEveryPresetToCron(every) };
  }
  if (cron !== undefined) {
    return {
      type: "cron",
      expression: cron.trim(),
      ...(trimmedTimeZone ? { timezone: trimmedTimeZone } : {}),
    };
  }
  return undefined;
}

export function compileEveryPresetToCron(value: string): string {
  const durationMs = parseDuration(value);
  const cron = everyMsToFiveFieldCron(durationMs);
  if (cron) {
    return cron;
  }

  throw {
    code: "UNREPRESENTABLE_CADENCE",
    message: `${value} cannot be represented faithfully by five-field cron`,
    details: "Use --cron for calendar schedules",
  } satisfies CommandError;
}

function parseTimeZoneFlag(timeZone: string | undefined): string | undefined {
  if (timeZone === undefined) {
    return undefined;
  }
  const trimmed = timeZone.trim();
  if (!trimmed) {
    throw {
      code: "INVALID_TIME_ZONE",
      message: "--timezone cannot be empty",
    } satisfies CommandError;
  }
  return trimmed;
}

function parseUpdateMaxRuns(options: ScheduleUpdateOptionsInput): number | null | undefined {
  if (options.maxRuns !== undefined && options.clearMaxRuns) {
    throw {
      code: "CONFLICTING_MAX_RUNS",
      message: "Use either --max-runs <n> or --no-max-runs, not both",
    } satisfies CommandError;
  }
  if (options.clearMaxRuns) {
    return null;
  }
  if (options.maxRuns !== undefined) {
    return parsePositiveInt(options.maxRuns, "--max-runs");
  }
  return undefined;
}

function parseUpdateExpiresAt(options: ScheduleUpdateOptionsInput): string | null | undefined {
  if (options.expiresIn !== undefined && options.clearExpires) {
    throw {
      code: "CONFLICTING_EXPIRES",
      message: "Use either --expires-in <duration> or --no-expires-in, not both",
    } satisfies CommandError;
  }
  if (options.clearExpires) {
    return null;
  }
  if (options.expiresIn !== undefined) {
    return new Date(Date.now() + parseDuration(options.expiresIn)).toISOString();
  }
  return undefined;
}

function parseUpdateName(options: ScheduleUpdateOptionsInput): string | null | undefined {
  if (options.name === undefined) {
    return undefined;
  }
  const trimmed = options.name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseUpdatePrompt(options: ScheduleUpdateOptionsInput): string | undefined {
  if (options.prompt === undefined) {
    return undefined;
  }
  const trimmed = options.prompt.trim();
  if (!trimmed) {
    throw {
      code: "INVALID_PROMPT",
      message: "--prompt cannot be empty",
    } satisfies CommandError;
  }
  return trimmed;
}

function buildNewAgentConfigPatch(
  options: ScheduleUpdateOptionsInput,
): UpdateScheduleNewAgentConfig | undefined {
  const patch: UpdateScheduleNewAgentConfig = {};
  if (options.provider !== undefined || options.model !== undefined) {
    const resolved = resolveProviderAndModel({
      provider: options.provider,
      model: options.model,
    });
    patch.provider = resolved.provider;
    if (resolved.model !== undefined) {
      patch.model = resolved.model;
    }
  }
  if (options.mode !== undefined) {
    const trimmed = options.mode.trim();
    patch.modeId = trimmed.length > 0 ? trimmed : null;
  }
  if (options.cwd !== undefined) {
    const trimmed = options.cwd.trim();
    if (!trimmed) {
      throw {
        code: "INVALID_CWD",
        message: "--cwd cannot be empty",
      } satisfies CommandError;
    }
    patch.cwd = trimmed;
  }
  if (options.workspaceId !== undefined && options.clearWorkspaceId) {
    throw {
      code: "CONFLICTING_WORKSPACE_ID",
      message: "Use either --workspace-id <id> or --no-workspace-id, not both",
    } satisfies CommandError;
  }
  if (options.workspaceId !== undefined) {
    // Same pairing as create: naming a workspace also stops the schedule archiving
    // one per run. Without this an update could leave the unsafe pair in place on a
    // schedule that was created before --workspace-id existed, or on one whose
    // archiveOnFinish was left at its default.
    patch.workspaceId = parseWorkspaceId(options.workspaceId);
    patch.archiveOnFinish = false;
  } else if (options.clearWorkspaceId) {
    patch.workspaceId = null;
    // Clearing reuse restores the per-run workspace behaviour, and that includes
    // archiving each one. Reuse is what pins archiveOnFinish false; leaving it
    // false here would rebuild the leak this feature exists to avoid — one
    // never-archived workspace per run, accumulating for the life of the schedule.
    patch.archiveOnFinish = true;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function parseWorkspaceId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw {
      code: "INVALID_WORKSPACE_ID",
      message: "--workspace-id cannot be empty",
    } satisfies CommandError;
  }
  return trimmed;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw {
      code: "INVALID_INTEGER",
      message: `${flag} must be a positive integer`,
    } satisfies CommandError;
  }
  return parsed;
}

export interface ScheduleRow {
  id: string;
  name: string | null;
  cadence: string;
  target: string;
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export function toScheduleRow(schedule: ScheduleListItem | ScheduleRecord): ScheduleRow {
  return {
    id: schedule.id,
    name: schedule.name,
    cadence: formatCadence(schedule.cadence),
    target: formatTarget(schedule.target),
    status: schedule.status,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
  };
}
