import { describe, expect, it } from "vitest";

import { mapToolCallEvent, mapToolResultEvent, toolKindFor } from "./tools.js";

describe("toolKindFor", () => {
  it("maps known tools", () => {
    expect(toolKindFor("read_files")).toBe("read");
    expect(toolKindFor("run_terminal_command")).toBe("execute");
    expect(toolKindFor("str_replace")).toBe("edit");
    expect(toolKindFor("code_search")).toBe("search");
    expect(toolKindFor("web_search")).toBe("fetch");
    expect(toolKindFor("think_deeply")).toBe("think");
  });

  it("defaults unknown tools to other", () => {
    expect(toolKindFor("mystery_tool")).toBe("other");
  });
});

describe("mapToolCallEvent", () => {
  it("builds an in_progress tool_call update with a readable title", () => {
    const update = mapToolCallEvent({
      type: "tool_call",
      toolCallId: "t1",
      toolName: "run_terminal_command",
      input: { command: "npm test" },
    });
    expect(update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "execute",
      status: "in_progress",
    });
    expect(update.title).toContain("Run Terminal Command");
    expect(update.title).toContain("npm test");
  });

  it("carries rawInput, absolute locations and edit diffs", () => {
    const update = mapToolCallEvent(
      {
        type: "tool_call",
        toolCallId: "e1",
        toolName: "str_replace",
        input: { path: "src/a.ts", replacements: [{ old: "a", new: "b" }] },
      },
      "/work",
    );
    expect(update).toMatchObject({
      rawInput: { path: "src/a.ts" },
      locations: [{ path: "/work/src/a.ts" }],
      content: [{ type: "diff", path: "/work/src/a.ts", oldText: "a", newText: "b" }],
    });
  });

  it("renders write_file as a diff against nothing and read_files as locations", () => {
    const write = mapToolCallEvent(
      {
        type: "tool_call",
        toolCallId: "w1",
        toolName: "write_file",
        input: { path: "/x/n.ts", content: "hi" },
      },
      "/work",
    );
    expect(write).toMatchObject({
      content: [{ type: "diff", path: "/x/n.ts", oldText: null, newText: "hi" }],
    });
    const read = mapToolCallEvent(
      {
        type: "tool_call",
        toolCallId: "r1",
        toolName: "read_files",
        input: { paths: ["a.ts", "/abs/b.ts"] },
      },
      "/work",
    );
    expect(read).toMatchObject({ locations: [{ path: "/work/a.ts" }, { path: "/abs/b.ts" }] });
  });

  it("handles empty input", () => {
    const update = mapToolCallEvent({
      type: "tool_call",
      toolCallId: "t2",
      toolName: "glob",
      input: {},
    });
    expect(update.title).toBe("Glob");
  });
});

describe("mapToolResultEvent", () => {
  it("marks completed and carries text content", () => {
    const update = mapToolResultEvent({
      type: "tool_result",
      toolCallId: "t1",
      toolName: "read_files",
      output: [{ type: "json", value: "file contents here" }],
    });
    expect(update.status).toBe("completed");
    expect(update.content?.[0]).toMatchObject({
      type: "content",
      content: { type: "text", text: "file contents here" },
    });
  });

  it("marks failed when output carries an error object", () => {
    const update = mapToolResultEvent({
      type: "tool_result",
      toolCallId: "t3",
      toolName: "run_terminal_command",
      output: [{ type: "json", value: { error: "boom" } }],
    });
    expect(update.status).toBe("failed");
  });

  it("forwards image media outputs and skips non-image media", () => {
    const image = mapToolResultEvent({
      type: "tool_result",
      toolCallId: "t4",
      toolName: "read_files",
      output: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
    expect(image.status).toBe("completed");
    expect(image.content?.[0]).toMatchObject({
      type: "content",
      content: { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    });
    const other = mapToolResultEvent({
      type: "tool_result",
      toolCallId: "t5",
      toolName: "read_files",
      output: [{ type: "media", data: "x", mediaType: "application/pdf" }],
    });
    expect(other.content).toBeUndefined();
  });

  it("exposes the structured result as rawOutput", () => {
    const update = mapToolResultEvent({
      type: "tool_result",
      toolCallId: "t6",
      toolName: "run_terminal_command",
      output: [{ type: "json", value: { stdout: "ok", exitCode: 0 } }],
    });
    expect(update.rawOutput).toEqual({ stdout: "ok", exitCode: 0 });
  });
});
