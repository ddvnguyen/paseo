/**
 * The name a schedule run gives the conversation it dispatches:
 * `#<ordinal> - <YYMMDD-HH>`, e.g. `#38 - 261002-06`.
 *
 * A schedule that starts a fresh agent every tick leaves one conversation per run,
 * and they all carry the same prompt-derived title, so the agent list is a column of
 * identical rows. The ordinal answers "which run" and the timestamp answers "when",
 * both of which the user otherwise has to dig out of the schedule's run history.
 *
 * The conversation is the object, not the workspace. The owner asked for this
 * explicitly: a run's workspace may be shared with every other run of the same
 * schedule, so naming it would make the name describe the latest dispatch rather
 * than the conversation being read.
 *
 * The timestamp is rendered in the SCHEDULE's timezone (its cron cadence's), not
 * the daemon's: a schedule the user configured as `0 9 * * *` in Asia/Bangkok must
 * read `09` there, even on a daemon running somewhere else. With no timezone set
 * the stamp follows the daemon's local time, which is the frame of reference a
 * user reading an `every` schedule already has.
 */

/** Matches a name this module produced. Used where a dispatch name must not be overwritten. */
const SCHEDULE_RUN_CONVERSATION_NAME_PATTERN = /^#\d+ - \d{6}-\d{2}$/;

export function formatRunConversationName(ordinal: number, at: Date, timeZone?: string): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error(`Schedule run conversation name needs a 1-based ordinal, got: ${ordinal}`);
  }
  const dispatch = readDispatchParts(at, timeZone);
  const year = String(dispatch.year % 100).padStart(2, "0");
  const month = String(dispatch.month).padStart(2, "0");
  const day = String(dispatch.day).padStart(2, "0");
  const hour = String(dispatch.hour).padStart(2, "0");
  return `#${ordinal} - ${year}${month}${day}-${hour}`;
}

export function isRunConversationName(name: string | null | undefined): boolean {
  return SCHEDULE_RUN_CONVERSATION_NAME_PATTERN.test(name ?? "");
}

interface DispatchParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

function readDispatchParts(at: Date, timeZone: string | undefined): DispatchParts {
  // hourCycle h23 keeps midnight at 00 instead of rolling it to 24, which h12
  // does. Omitting timeZone is deliberate: Intl then reads the daemon's local
  // zone, which is what an unzoned schedule is configured against.
  const formatter = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  });

  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(at)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  return {
    year: Number.parseInt(values.year ?? "", 10),
    month: Number.parseInt(values.month ?? "", 10),
    day: Number.parseInt(values.day ?? "", 10),
    hour: Number.parseInt(values.hour ?? "", 10),
  };
}
