import { describe, expect, it } from "vitest";
import { ScheduleCreateRequestSchema, ScheduleUpdateRequestSchema } from "./rpc-schemas.js";

describe("schedule RPC schemas", () => {
  it("round-trips new-agent run options on create requests", () => {
    expect(
      ScheduleCreateRequestSchema.parse({
        type: "schedule/create",
        requestId: "request-1",
        prompt: "Run the task",
        cadence: { type: "every", everyMs: 60_000 },
        target: {
          type: "new-agent",
          config: {
            provider: "claude",
            cwd: "/tmp/project",
            thinkingOptionId: "think-hard",
            archiveOnFinish: false,
            isolation: "worktree",
          },
        },
      }),
    ).toEqual({
      type: "schedule/create",
      requestId: "request-1",
      prompt: "Run the task",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: "/tmp/project",
          thinkingOptionId: "think-hard",
          archiveOnFinish: false,
          isolation: "worktree",
        },
      },
    });
  });

  it("round-trips new-agent run options on update requests", () => {
    expect(
      ScheduleUpdateRequestSchema.parse({
        type: "schedule/update",
        requestId: "request-1",
        scheduleId: "schedule-1",
        newAgentConfig: {
          thinkingOptionId: "think-hard",
          archiveOnFinish: false,
          isolation: "worktree",
        },
      }),
    ).toEqual({
      type: "schedule/update",
      requestId: "request-1",
      scheduleId: "schedule-1",
      newAgentConfig: {
        thinkingOptionId: "think-hard",
        archiveOnFinish: false,
        isolation: "worktree",
      },
    });
  });

  // A Zod object strips keys it does not declare, so a field missing from this schema
  // is not rejected — it vanishes, and the daemon reports the update as applied. This
  // is the shape of the bug that made `schedule update --workspace-id` a silent no-op
  // against a daemon built before the field existed. Both directions are pinned here
  // because both were dropped the same way.
  it("keeps workspaceId and nameRunConversations on update requests", () => {
    const request = {
      type: "schedule/update",
      requestId: "request-1",
      scheduleId: "schedule-1",
      newAgentConfig: {
        workspaceId: "wks_shared",
        nameRunConversations: true,
      },
    };
    expect(ScheduleUpdateRequestSchema.parse(request)).toEqual(request);
  });

  it("keeps a null clear for workspaceId and nameRunConversations", () => {
    const request = {
      type: "schedule/update",
      requestId: "request-1",
      scheduleId: "schedule-1",
      newAgentConfig: { workspaceId: null, nameRunConversations: null },
    };
    expect(ScheduleUpdateRequestSchema.parse(request)).toEqual(request);
  });

  it("keeps nameRunConversations on a create target, where the config schema is shared", () => {
    const request = {
      type: "schedule/create",
      requestId: "request-1",
      prompt: "do the thing",
      cadence: { type: "every", everyMs: 300_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: "/repo",
          workspaceId: "wks_shared",
          nameRunConversations: true,
        },
      },
    };
    expect(ScheduleCreateRequestSchema.parse(request)).toEqual(request);
  });
});
