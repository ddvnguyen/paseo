import { describe, expect, it } from "vitest";
import { runStateToReplayUpdates } from "./history-replay.js";

const runState = {
  mainAgentState: {
    messageHistory: [
      { role: "user", tags: ["USER_PROMPT"], content: [{ type: "text", text: "hi" }] },
      { role: "user", tags: ["INSTRUCTIONS"], content: [{ type: "text", text: "injected" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "thinking" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolName: "read_files", toolCallId: "t1", input: { a: 1 } }],
      },
      { role: "tool", toolCallId: "t1", content: [{ type: "json", value: "x".repeat(9000) }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
  },
};

describe("runStateToReplayUpdates", () => {
  it("replays user prompts, thoughts, tools and answers in order, skipping injected context", () => {
    const kinds = runStateToReplayUpdates(runState).map((update) => update.sessionUpdate);
    expect(kinds).toEqual([
      "user_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
    ]);
  });

  it("truncates large tool output", () => {
    const update = runStateToReplayUpdates(runState).find(
      (u) => u.sessionUpdate === "tool_call_update",
    );
    expect(String(update?.rawOutput).length).toBeLessThan(4100);
  });

  it("returns nothing for an empty or missing RunState", () => {
    expect(runStateToReplayUpdates(null)).toEqual([]);
    expect(runStateToReplayUpdates({})).toEqual([]);
  });
});
