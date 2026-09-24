import { describe, expect, it, vi } from "vitest";

import { answerToOutput, createAskUserTool } from "./ask-user.js";

const questions = [
  {
    question: "Which env?",
    header: "Deploy",
    options: [{ label: "staging" }, { label: "prod", description: "careful" }],
  },
];

type Response = { outcome: { outcome: string; optionId?: string }; _meta?: unknown };

function run(tool: ReturnType<typeof createAskUserTool>, input: unknown = { questions }) {
  return tool(input as never) as Promise<Array<{ value: unknown }>>;
}

describe("answerToOutput", () => {
  const multi = {
    question: "q",
    multiSelect: true,
    options: [{ label: "web" }, { label: "ios, android" }, { label: "ios" }],
  };

  it("maps single-select labels and free text", () => {
    const single = { question: "q", options: [{ label: "a" }] };
    expect(answerToOutput(single, 0, "a")).toEqual({ questionIndex: 0, selectedOption: "a" });
    expect(answerToOutput(single, 2, "something else")).toEqual({
      questionIndex: 2,
      otherText: "something else",
    });
    expect(answerToOutput(single, 0, "  ")).toBeNull();
  });

  it("splits multi-select on known labels, preferring the longest when a label contains a comma", () => {
    // The app joins labels with ", ", so "ios, android" is inherently
    // ambiguous; the longest known label wins.
    expect(answerToOutput(multi, 1, "web, ios, android")).toEqual({
      questionIndex: 1,
      selectedOptions: ["web", "ios, android"],
    });
    expect(answerToOutput(multi, 0, "ios, web")).toEqual({
      questionIndex: 0,
      selectedOptions: ["ios", "web"],
    });
  });

  it("keeps free text alongside selected labels", () => {
    expect(answerToOutput(multi, 0, "web, watchOS")).toEqual({
      questionIndex: 0,
      selectedOptions: ["web"],
      otherText: "watchOS",
    });
  });
});

describe("createAskUserTool", () => {
  it("sends the rich form in _meta and returns multi-select + free-text answers", async () => {
    const requestPermission = vi.fn(
      async (): Promise<Response> => ({
        outcome: { outcome: "selected", optionId: "ask-user-0-0" },
        _meta: { "paseo/answers": { Deploy: "staging, prod", Notes: "ship it Friday" } },
      }),
    );
    const tool = createAskUserTool(() => ({ sessionId: "s", requestPermission }));
    const [result] = await run(tool, {
      questions: [
        { ...questions[0], multiSelect: true },
        { question: "Any notes?", header: "Notes", options: [] },
      ],
    });
    expect(result?.value).toEqual({
      answers: [
        { questionIndex: 0, selectedOptions: ["staging", "prod"] },
        { questionIndex: 1, otherText: "ship it Friday" },
      ],
    });
    const request = (requestPermission.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(request._meta).toMatchObject({
      "paseo/questions": [
        { header: "Deploy", multiSelect: true, allowOther: true },
        { header: "Notes", multiSelect: false, allowOther: true, options: [] },
      ],
    });
    // Fallback chooser carries the first question's options.
    expect((request.options as Array<{ name: string }>).map((option) => option.name)).toEqual([
      "staging",
      "prod — careful",
      "Skip",
    ]);
    // Only one round trip for the whole form.
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("gives a pure free-text first question an allow option to submit with", async () => {
    const requestPermission = vi.fn(
      async (): Promise<Response> => ({
        outcome: { outcome: "selected", optionId: "ask-user-submit" },
        _meta: { "paseo/answers": { Name: "Ada" } },
      }),
    );
    const tool = createAskUserTool(() => ({ sessionId: "s", requestPermission }));
    const [result] = await run(tool, {
      questions: [{ question: "Your name?", header: "Name", options: [] }],
    });
    expect(result?.value).toEqual({ answers: [{ questionIndex: 0, otherText: "Ada" }] });
    const request = (requestPermission.mock.calls[0] as unknown as [{ options: unknown[] }])[0];
    expect(request.options).toContainEqual(
      expect.objectContaining({ optionId: "ask-user-submit", kind: "allow_once" }),
    );
  });

  it("falls back to sequential single-choice questions on hosts without the extension", async () => {
    const requestPermission = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce({ outcome: { outcome: "selected", optionId: "ask-user-0-1" } })
      .mockResolvedValueOnce({ outcome: { outcome: "selected", optionId: "ask-user-1-0" } });
    const tool = createAskUserTool(() => ({ sessionId: "s", requestPermission }));
    const [result] = await run(tool, {
      questions: [
        questions[0],
        { question: "Region?", header: "Region", options: [{ label: "eu" }] },
      ],
    });
    expect(result?.value).toEqual({
      answers: [
        { questionIndex: 0, selectedOption: "prod" },
        { questionIndex: 1, selectedOption: "eu" },
      ],
    });
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });

  it("reports skipped on cancel, skip, missing host, or a failing host", async () => {
    const cancelled = createAskUserTool(() => ({
      sessionId: "s",
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    }));
    expect((await run(cancelled))[0]?.value).toEqual({ skipped: true });
    const skipped = createAskUserTool(() => ({
      sessionId: "s",
      requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "ask-user-skip" } }),
    }));
    expect((await run(skipped))[0]?.value).toEqual({ skipped: true });
    expect((await run(createAskUserTool(() => null)))[0]?.value).toEqual({ skipped: true });
    const failing = createAskUserTool(() => ({
      sessionId: "s",
      requestPermission: async () => {
        throw new Error("host gone");
      },
    }));
    expect((await run(failing))[0]?.value).toEqual({ skipped: true });
  });
});
