#!/usr/bin/env npx tsx

import assert from "node:assert";
import { rm } from "node:fs/promises";
import { createE2ETestContext } from "./helpers/test-daemon.ts";

console.log("=== Schedule Command Tests ===\n");

const ctx = await createE2ETestContext({ timeout: 30000 });

try {
  {
    console.log("Test 1: schedule create/ls/inspect/pause/resume/delete work");
    const created = await ctx.paseo(
      [
        "schedule",
        "create",
        "Review new PRs",
        "--every",
        "5m",
        "--name",
        "review-prs",
        "--provider",
        "claude",
        "--cwd",
        ctx.workDir,
        "--json",
      ],
      { timeout: 30000 },
    );
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);
    assert.strictEqual(createdJson.name, "review-prs");
    assert.strictEqual(createdJson.cadence, "cron:*/5 * * * *");
    assert(
      typeof createdJson.target === "string" &&
        (createdJson.target.startsWith("agent:") || createdJson.target === "new-agent:claude"),
      created.stdout,
    );

    const listed = await ctx.paseo(["schedule", "ls", "--json"]);
    assert.strictEqual(listed.exitCode, 0, listed.stderr);
    const listedJson = JSON.parse(listed.stdout);
    assert(Array.isArray(listedJson), listed.stdout);
    assert(
      listedJson.some((item: { id: string }) => item.id === createdJson.id),
      listed.stdout,
    );

    const inspected = await ctx.paseo(["schedule", "inspect", createdJson.id, "--json"]);
    assert.strictEqual(inspected.exitCode, 0, inspected.stderr);
    const inspectedJson = JSON.parse(inspected.stdout);
    assert.strictEqual(inspectedJson.status, "active");
    assert.strictEqual(inspectedJson.prompt, "Review new PRs");

    const paused = await ctx.paseo(["schedule", "pause", createdJson.id, "--json"]);
    assert.strictEqual(paused.exitCode, 0, paused.stderr);
    assert.strictEqual(JSON.parse(paused.stdout).status, "paused");

    const resumed = await ctx.paseo(["schedule", "resume", createdJson.id, "--json"]);
    assert.strictEqual(resumed.exitCode, 0, resumed.stderr);
    assert.strictEqual(JSON.parse(resumed.stdout).status, "active");

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    assert.strictEqual(JSON.parse(deleted.stdout).id, createdJson.id);
    console.log("schedule commands work\n");
  }

  {
    console.log("Test 1b: schedule create accepts provider/model syntax for new-agent runs");
    const created = await ctx.paseo(
      [
        "schedule",
        "create",
        "Refactor the API layer",
        "--every",
        "10m",
        "--provider",
        "codex/gpt-5.4",
        "--thinking",
        "high",
        "--cwd",
        ctx.workDir,
        "--json",
      ],
      { timeout: 30000 },
    );
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);
    assert.strictEqual(createdJson.target, "new-agent:codex/gpt-5.4");

    const inspected = await ctx.paseo(["schedule", "inspect", createdJson.id, "--json"]);
    assert.strictEqual(inspected.exitCode, 0, inspected.stderr);
    const inspectedJson = JSON.parse(inspected.stdout);
    assert.strictEqual(inspectedJson.target.config.provider, "codex");
    assert.strictEqual(inspectedJson.target.config.model, "gpt-5.4");
    assert.strictEqual(inspectedJson.target.config.thinkingOptionId, "high");

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule provider/model syntax works\n");
  }

  {
    console.log("Test 1c: schedule create rejects provider with self target");
    const result = await ctx.paseo(
      [
        "schedule",
        "create",
        "Conflicting schedule",
        "--every",
        "5m",
        "--target",
        "self",
        "--provider",
        "codex/gpt-5.4",
        "--cwd",
        ctx.workDir,
      ],
      { timeout: 30000 },
    );
    assert.notStrictEqual(result.exitCode, 0, "should fail for self target with provider");
    const output = result.stdout + result.stderr;
    assert(
      output.includes("can only be used with a new-agent target"),
      "should explain provider target mismatch",
    );
    console.log("schedule rejects provider with self target\n");
  }

  {
    console.log("Test 1d: compatibility agent-target schedules remain deletable");
    const created = await ctx.paseo(
      [
        "schedule",
        "create",
        "Legacy heartbeat",
        "--cron",
        "0 0 1 1 *",
        "--target",
        "00000000-0000-4000-8000-000000000001",
        "--cwd",
        ctx.workDir,
        "--json",
      ],
      { timeout: 30000 },
    );
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);
    assert.strictEqual(createdJson.target, "agent:0000000");

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    assert.strictEqual(JSON.parse(deleted.stdout).id, createdJson.id);
    console.log("compatibility agent-target schedules remain deletable\n");
  }
  {
    console.log("Test 1e: schedule create --workspace-id pins archiveOnFinish false");
    // The id does not have to resolve here; whether a run can safely reuse it is
    // the daemon's decision at tick time and is covered by the server schedule
    // tests. This asserts the CLI half — what actually reaches the daemon.
    const created = await ctx.paseo(
      [
        "schedule",
        "create",
        "Review in one shared workspace",
        "--every",
        "5m",
        "--provider",
        "claude",
        "--cwd",
        ctx.workDir,
        "--workspace-id",
        "wks_e2e_shared",
        "--json",
      ],
      { timeout: 30000 },
    );
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const createdJson = JSON.parse(created.stdout);

    const inspected = await ctx.paseo(["schedule", "inspect", createdJson.id, "--json"]);
    assert.strictEqual(inspected.exitCode, 0, inspected.stderr);
    const config = JSON.parse(inspected.stdout).target.config;
    assert.strictEqual(config.workspaceId, "wks_e2e_shared");
    // A workspace that is archived per run is not shared at all, so asking for one
    // workspace has to turn archiving off.
    assert.strictEqual(config.archiveOnFinish, false);

    const deleted = await ctx.paseo(["schedule", "delete", createdJson.id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule create --workspace-id pins archiveOnFinish false\n");
  }

  {
    console.log("Test 1f: schedule update sets, replaces, and clears workspace reuse");
    const created = await ctx.paseo(
      [
        "schedule",
        "create",
        "Update workspace reuse",
        "--every",
        "5m",
        "--provider",
        "claude",
        "--cwd",
        ctx.workDir,
        "--json",
      ],
      { timeout: 30000 },
    );
    assert.strictEqual(created.exitCode, 0, created.stderr);
    const id = JSON.parse(created.stdout).id;

    const readConfig = async () => {
      const inspected = await ctx.paseo(["schedule", "inspect", id, "--json"]);
      assert.strictEqual(inspected.exitCode, 0, inspected.stderr);
      return JSON.parse(inspected.stdout).target.config;
    };

    const set = await ctx.paseo(
      ["schedule", "update", id, "--workspace-id", "wks_e2e_first", "--json"],
      { timeout: 30000 },
    );
    assert.strictEqual(set.exitCode, 0, set.stderr);
    let config = await readConfig();
    assert.strictEqual(config.workspaceId, "wks_e2e_first");
    assert.strictEqual(
      config.archiveOnFinish,
      false,
      "update --workspace-id must also stop the schedule archiving the shared workspace",
    );

    const replaced = await ctx.paseo(
      ["schedule", "update", id, "--workspace-id", "wks_e2e_second", "--json"],
      { timeout: 30000 },
    );
    assert.strictEqual(replaced.exitCode, 0, replaced.stderr);
    config = await readConfig();
    assert.strictEqual(config.workspaceId, "wks_e2e_second");

    // Without a clear flag a set id could never be removed, so the schedule would
    // keep sharing that workspace for the rest of its life.
    const cleared = await ctx.paseo(["schedule", "update", id, "--no-workspace-id", "--json"], {
      timeout: 30000,
    });
    assert.strictEqual(cleared.exitCode, 0, cleared.stderr);
    config = await readConfig();
    assert.strictEqual(
      config.workspaceId,
      undefined,
      "--no-workspace-id must drop the shared workspace",
    );

    const deleted = await ctx.paseo(["schedule", "delete", id, "--json"]);
    assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    console.log("schedule update sets, replaces, and clears workspace reuse\n");
  }

  {
    console.log("Test 1g: schedule rejects an empty --workspace-id");
    const created = await ctx.paseo(
      [
        "schedule",
        "create",
        "Empty workspace id",
        "--every",
        "5m",
        "--provider",
        "claude",
        "--cwd",
        ctx.workDir,
        "--workspace-id",
        "   ",
        "--json",
      ],
      { timeout: 30000 },
    );
    assert.notStrictEqual(created.exitCode, 0, "should fail for an empty --workspace-id");
    const output = created.stdout + created.stderr;
    assert(
      output.includes("--workspace-id cannot be empty"),
      `should explain the empty workspace id, got: ${output}`,
    );
    console.log("schedule rejects an empty --workspace-id\n");
  }
  {
    console.log("Test 1h: schedule create warns when another schedule shares the workspace");
    const args = (workspaceId: string) => [
      "schedule",
      "create",
      "Shared workspace",
      "--every",
      "5m",
      "--provider",
      "claude",
      "--cwd",
      ctx.workDir,
      "--workspace-id",
      workspaceId,
      "--json",
    ];

    const first = await ctx.paseo(args("wks_e2e_shared_pair"), { timeout: 30000 });
    assert.strictEqual(first.exitCode, 0, first.stderr);
    const firstJson = JSON.parse(first.stdout);

    // Nothing excludes one schedule's run from another's, so the CLI says so
    // instead of letting two schedules quietly share a directory.
    const second = await ctx.paseo(args("wks_e2e_shared_pair"), { timeout: 30000 });
    assert.strictEqual(second.exitCode, 0, second.stderr);
    assert(
      second.stderr.includes("already use workspace wks_e2e_shared_pair"),
      `should warn about the shared workspace, got: ${second.stderr}`,
    );
    const secondJson = JSON.parse(second.stdout);

    for (const id of [firstJson.id, secondJson.id]) {
      const deleted = await ctx.paseo(["schedule", "delete", id, "--json"]);
      assert.strictEqual(deleted.exitCode, 0, deleted.stderr);
    }
    console.log("schedule create warns when another schedule shares the workspace\n");
  }
} finally {
  await ctx.stop();
  await rm(ctx.paseoHome, { recursive: true, force: true });
  await rm(ctx.workDir, { recursive: true, force: true });
}

console.log("=== Schedule Command Tests Passed ===");
