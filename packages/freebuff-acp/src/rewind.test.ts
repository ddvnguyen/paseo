import { describe, expect, it } from "vitest";

import {
  checkpointForRewind,
  checkpointsAfterRewind,
  countUserTurns,
  MAX_CHECKPOINTS,
  recordCheckpoint,
  reconstructCheckpoint,
} from "./rewind.js";

/** RunState with `turns` USER_PROMPT-tagged user messages (plus a reply each). */
function runStateWithTurns(turns: number): Record<string, unknown> {
  const history: Array<Record<string, unknown>> = [];
  for (let index = 1; index <= turns; index += 1) {
    history.push({
      role: "user",
      tags: ["USER_PROMPT"],
      content: [{ type: "text", text: `prompt ${index}` }],
    });
    history.push({
      role: "assistant",
      content: [{ type: "text", text: `answer ${index}` }],
    });
  }
  return {
    mainAgentState: { contextTokenCount: 1000 * turns, messageHistory: history },
    sessionId: "sdk-run",
  };
}

describe("countUserTurns", () => {
  it("counts USER_PROMPT-tagged messages only", () => {
    expect(countUserTurns(runStateWithTurns(3))).toBe(3);
    expect(countUserTurns(null)).toBe(0);
    expect(
      countUserTurns({
        mainAgentState: {
          messageHistory: [{ role: "user", content: [{ type: "text", text: "injected" }] }],
        },
      }),
    ).toBe(0);
  });
});

describe("recordCheckpoint", () => {
  it("records the pre-turn state keyed by the prompt's ordinal", () => {
    const checkpoints = recordCheckpoint({
      checkpoints: [],
      turn: 1,
      promptText: "first",
      runState: null,
    });
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ turn: 1, runState: null, promptText: "first" });

    const second = recordCheckpoint({
      checkpoints,
      turn: 2,
      promptText: "second",
      runState: runStateWithTurns(1),
    });
    expect(second).toHaveLength(2);
    expect(second[1]?.turn).toBe(2);
  });

  it("is bounded by MAX_CHECKPOINTS, dropping the oldest", () => {
    let checkpoints: ReturnType<typeof recordCheckpoint> = [];
    for (let turn = 1; turn <= MAX_CHECKPOINTS + 5; turn += 1) {
      checkpoints = recordCheckpoint({
        checkpoints,
        turn,
        promptText: `p${turn}`,
        runState: null,
      });
    }
    expect(checkpoints).toHaveLength(MAX_CHECKPOINTS);
    expect(checkpoints[0]?.turn).toBe(6);
  });
});

describe("checkpointForRewind", () => {
  it("prefers the recorded checkpoint", () => {
    const recorded = recordCheckpoint({
      checkpoints: [],
      turn: 2,
      promptText: "p2",
      runState: runStateWithTurns(1),
    });
    const checkpoint = checkpointForRewind(recorded, runStateWithTurns(5), 2);
    expect(checkpoint?.turn).toBe(2);
    expect(checkpoint?.promptText).toBe("p2");
    expect(checkpoint?.runState).toEqual(runStateWithTurns(1));
  });

  it("reconstructs from the live state when the ring missed the turn", () => {
    const state = runStateWithTurns(3);
    const checkpoint = checkpointForRewind([], state, 2);
    expect(checkpoint).not.toBeNull();
    // Restored state = conversation before turn 2 = exactly turn 1.
    expect(countUserTurns(checkpoint?.runState ?? null)).toBe(1);
    expect(checkpoint?.promptText).toBe("prompt 2");
    const main = (checkpoint?.runState as { mainAgentState?: { messageHistory?: unknown[] } })
      ?.mainAgentState;
    expect(main?.messageHistory).toHaveLength(2); // user + assistant of turn 1
  });

  it("returns null for an unknown turn", () => {
    expect(checkpointForRewind([], runStateWithTurns(2), 5)).toBeNull();
    expect(checkpointForRewind([], null, 1)).toBeNull();
    expect(checkpointForRewind([], runStateWithTurns(1), 0)).toBeNull();
  });
});

describe("checkpointsAfterRewind", () => {
  it("keeps only checkpoints before the rewind point", () => {
    let checkpoints: ReturnType<typeof recordCheckpoint> = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      checkpoints = recordCheckpoint({
        checkpoints,
        turn,
        promptText: `p${turn}`,
        runState: null,
      });
    }
    const surviving = checkpointsAfterRewind(checkpoints, 3);
    expect(surviving.map((c) => c.turn)).toEqual([1, 2]);
  });
});

describe("reconstructCheckpoint", () => {
  it("returns null when the turn has no USER_PROMPT marker", () => {
    const state = {
      mainAgentState: {
        messageHistory: [{ role: "user", content: [{ type: "text", text: "injected" }] }],
      },
    };
    expect(reconstructCheckpoint(state, 1)).toBeNull();
  });

  it("restores the exact pre-turn history slice", () => {
    const state = runStateWithTurns(4);
    const checkpoint = reconstructCheckpoint(state, 4);
    expect(countUserTurns(checkpoint?.runState ?? null)).toBe(3);
    // SDK bookkeeping outside mainAgentState is preserved (counters survive).
    expect(checkpoint?.runState).toMatchObject({ sessionId: "sdk-run" });
  });
});
