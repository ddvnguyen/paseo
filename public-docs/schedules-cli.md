---
title: Schedules from the CLI
description: Create and manage Paseo schedules with paseo schedule.
nav: CLI
order: 27
category: Schedules
---

# Schedules from the CLI

`paseo schedule` creates and manages new-agent [schedules](/docs/schedules) from your terminal, useful for headless boxes and scripts. Every run starts a fresh agent.

## Create

Overnight refactor on Codex:

```bash
paseo schedule create \
  --every 30m \
  --name overnight-refactor \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  --max-runs 16 \
  --expires-in 10h \
  "Continue the refactor. Run the focused checks. Leave a short status note."
```

Long build babysitter on Claude:

```bash
paseo schedule create \
  --every 5m \
  --name build-watch \
  --provider claude/opus-4.7 \
  --cwd ~/dev/my-app \
  --max-runs 24 \
  "Check the release build. If it failed, inspect logs, fix the cause, and rerun."
```

Daily GitHub triage on GLM through OpenCode:

```bash
paseo schedule create \
  --cron "0 14 * * 1-5" \
  --timezone UTC \
  --run-now \
  --name github-triage \
  --provider opencode/openrouter/glm-5.1 \
  --cwd ~/dev/my-app \
  "Triage GitHub issues, PRs, and failing checks. Summarize what needs attention."
```

Morning triage at 9 AM in New York, including daylight saving time changes:

```bash
paseo schedule create \
  --cron "0 9 * * 1-5" \
  --timezone America/New_York \
  --name morning-triage \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  "Review overnight CI failures and summarize anything urgent."
```

## Heartbeats

Inside a running Paseo agent, create a heartbeat for that same conversation:

```bash
paseo heartbeat create \
  --cron "*/20 * * * *" \
  --name heartbeat \
  "Check the current task state and continue with the next useful step."
```

The heartbeat interface is deliberately small:

```bash
paseo heartbeat update <id> --cron "*/10 * * * *"
paseo heartbeat delete <id>
```

Updating a heartbeat changes only its cron cadence and optional time zone. Its target and prompt stay fixed. Heartbeat commands require `PASEO_AGENT_ID`, which Paseo sets inside agent sessions.

Heartbeats require a raw `--cron` expression. The `--every` presets below are available only for new-agent schedules.

## Manage

```bash
paseo schedule ls
paseo schedule inspect <id>
paseo schedule logs <id>
paseo schedule pause <id>
paseo schedule resume <id>
paseo schedule run-once <id>
paseo schedule update <id> --every 10m --max-runs 6
paseo schedule delete <id>
```

## Workspace per run

Each run of a new-agent schedule provisions its own workspace by default. Pass `--workspace-id <id>` to run every tick in one workspace you already have, so the schedule's history collects in a single place instead of a directory per run:

```bash
paseo schedule create --every 30m --cwd ~/dev/my-app \
  --workspace-id wks_abc123 \
  "Triage new issues."
```

Naming a workspace also stops the schedule archiving one per run; an archived workspace is not shared with anything. `--workspace-id` is safe to change later, and `--no-workspace-id` goes back to a workspace per run:

```bash
paseo schedule update <id> --workspace-id wks_def456
paseo schedule update <id> --no-workspace-id
```

`--no-workspace-id` goes back to a workspace per run, and those are archived again when the run ends. Reuse is what turned archiving off, so clearing it turns archiving back on.

The daemon re-checks reuse on every run rather than trusting the stored config, and refuses reuse — falling back to a workspace of that run's own, archived when the run ends — when the workspace is archived, when it does not exist, or when its directory differs from `--cwd`. A refused run logs a warning once per schedule, and the schedule keeps running.

Clearing reuse needs a daemon that understands it. Against an older daemon the command fails and asks you to update rather than sending a request it would reject.

Setting and clearing are both checked against the schedule the daemon returns, so a daemon too old to store a field fails the command and names the flag. A field the daemon silently ignored used to read as success while the schedule went on behaving as if the flag had never been passed.

### Naming each run's conversation

A schedule that starts a fresh agent every tick leaves one conversation per run, and they all carry the same title. Pass `--name-run-conversations` to title each one `#<run> - <YYMMDD-HH>`, where the number is the run's position in that schedule's own history and the stamp is the dispatch time in the schedule's timezone:

```bash
paseo schedule create --every 30m --cwd ~/dev/my-app \
  --name-run-conversations \
  "Triage new issues."
```

The name goes on the conversation, not the workspace — a workspace shared by every run can only carry the latest run's name, while each conversation keeps its own. `--no-name-run-conversations` goes back to titles derived from the prompt.

### Sharing one workspace between schedules

Two schedules can name the same workspace, and `paseo schedule create` / `update` warn when another schedule already uses it. Nothing serialises the two: their runs are independent, so agents from both can be working in the same directory at once, and a run that finishes does not wait for the other. Two schedules that write to the same files will collide. Give each schedule its own workspace, or use one schedule with a longer cadence.

## Cadence

Use `--cron "<expr>"` for a 5-field cron expression. For common cron-compatible cadences, `--every <duration>` accepts presets such as `5m` or `1h` and compiles them to cron. It does not create a rolling interval anchored to creation time.

Schedules default to UTC. Pass `--timezone <IANA>` to interpret cron fields in a local wall-clock time zone, for example `--timezone America/New_York`. The persisted `nextRunAt` is still a UTC instant, but it is computed from that local time zone so recurring jobs stay at the same local time across daylight saving time changes.

Schedules wait for the next matching cron time by default. Pass `--run-now` to start one immediate run on creation.

Start the command with `paseo --host <target> schedule create ...` when targeting a remote daemon. Pass `--cwd`; your local working directory may not exist on the remote machine.
