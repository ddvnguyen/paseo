import { describe, expect, it } from "vitest";

import { nextConversationState } from "./run-state.js";

const stateWith = (count: number) => ({
  mainAgentState: { messageHistory: Array.from({ length: count }, () => ({ role: "user" })) },
});

describe("nextConversationState", () => {
  it("keeps the previous conversation when the turn returns no state", () => {
    const previous = stateWith(10);
    expect(nextConversationState(previous, null, "refusal")).toBe(previous);
    expect(nextConversationState(previous, null, "cancelled")).toBe(previous);
  });

  it("does not let a failed turn replace history with a shorter fresh state", () => {
    const previous = stateWith(10);
    expect(nextConversationState(previous, stateWith(1), "refusal")).toBe(previous);
  });

  it("adopts partial progress from a cancelled or refused turn", () => {
    const next = stateWith(12);
    expect(nextConversationState(stateWith(10), next, "cancelled")).toBe(next);
    expect(nextConversationState(stateWith(10), next, "refusal")).toBe(next);
  });

  it("always adopts the state of a successful turn (history may be compacted)", () => {
    const next = stateWith(3);
    expect(nextConversationState(stateWith(10), next, "end_turn")).toBe(next);
  });

  it("starts from the new state when there was no previous conversation", () => {
    const next = stateWith(2);
    expect(nextConversationState(null, next, "refusal")).toBe(next);
    expect(nextConversationState(null, null, "refusal")).toBeNull();
  });
});
