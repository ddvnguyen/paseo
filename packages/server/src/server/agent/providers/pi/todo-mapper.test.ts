import { describe, expect, test } from "vitest";

import { parseToolResult } from "./tool-call-mapper.js";
import { mapPiTodoState, mapPiTodoToolResult } from "./todo-mapper.js";

const TODO_PHASES = [
  {
    name: "Tasks",
    tasks: [
      { content: "alpha task", status: "completed" },
      { content: "beta task", status: "in_progress" },
      { content: "gamma task", status: "pending" },
    ],
  },
] as const;

describe("Pi todo mapper", () => {
  test("maps todo tool results without losing progress status", () => {
    expect(
      mapPiTodoToolResult(
        parseToolResult({
          content: [],
          details: {
            phases: [
              {
                name: "Tasks",
                tasks: [
                  { content: "alpha task", status: "in_progress" },
                  { content: "beta task", status: "pending" },
                  { content: "gamma task", status: "pending" },
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [
        { text: "alpha task", status: "in_progress", completed: false },
        { text: "beta task", status: "pending", completed: false },
        { text: "gamma task", status: "pending", completed: false },
      ],
    });

    expect(
      mapPiTodoToolResult(parseToolResult({ content: [], details: { phases: TODO_PHASES } })),
    ).toEqual({
      type: "todo",
      items: [
        { text: "alpha task", status: "completed", completed: true },
        { text: "beta task", status: "in_progress", completed: false },
        { text: "gamma task", status: "pending", completed: false },
      ],
    });
  });

  test("returns null for todo tool results without phases", () => {
    expect(mapPiTodoToolResult(parseToolResult({ content: [] }))).toBeNull();
    expect(mapPiTodoToolResult(null)).toBeNull();
    expect(mapPiTodoToolResult("plain text result")).toBeNull();
  });

  test("ignores abandoned tasks by normalizing them to pending", () => {
    expect(
      mapPiTodoToolResult(
        parseToolResult({
          content: [],
          details: {
            phases: [
              { name: "Tasks", tasks: [{ content: "abandoned task", status: "abandoned" }] },
            ],
          },
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [{ text: "abandoned task", status: "pending", completed: false }],
    });
  });

  test("maps session state todoPhases", () => {
    expect(
      mapPiTodoState({
        sessionId: "sess-1",
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        messageCount: 1,
        pendingMessageCount: 0,
        todoPhases: TODO_PHASES,
      }),
    ).toEqual([
      {
        type: "todo",
        items: [
          { text: "alpha task", status: "completed", completed: true },
          { text: "beta task", status: "in_progress", completed: false },
          { text: "gamma task", status: "pending", completed: false },
        ],
      },
    ]);
  });

  test("returns no items when session state has no todoPhases", () => {
    expect(
      mapPiTodoState({
        sessionId: "sess-1",
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        messageCount: 1,
        pendingMessageCount: 0,
      }),
    ).toEqual([]);
  });

  test("returns null when todoPhases is empty", () => {
    expect(
      mapPiTodoToolResult(parseToolResult({ content: [], details: { phases: [] } })),
    ).toBeNull();
  });
});
