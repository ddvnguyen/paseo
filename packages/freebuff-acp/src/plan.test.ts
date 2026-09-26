import { describe, expect, it } from "vitest";

import { todosToPlan } from "./plan.js";

describe("todosToPlan", () => {
  it("marks completed items and the first unfinished item as in progress", () => {
    const plan = todosToPlan({
      todos: [
        { task: "read code", completed: true },
        { task: "write fix", completed: false },
        { task: "run tests", completed: false },
      ],
    });
    expect(plan?.entries.map((entry) => entry.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    expect(plan?.entries[1]?.content).toBe("write fix");
  });

  it("ignores malformed input", () => {
    expect(todosToPlan(null)).toBeNull();
    expect(todosToPlan({ todos: "nope" })).toBeNull();
    expect(todosToPlan({ todos: [{ task: "", completed: false }, 3] })?.entries).toEqual([]);
  });
});
