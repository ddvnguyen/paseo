import { describe, expect, test } from "vitest";

import { acpAnswersResponseMeta, readAcpQuestions } from "./acp-questions.js";

const question = { question: "Which?", header: "Pick", options: [{ label: "a" }] };

describe("readAcpQuestions", () => {
  test("returns the questions from _meta", () => {
    expect(readAcpQuestions({ "paseo/questions": [question] })).toEqual([question]);
  });

  test("ignores absent, empty and malformed extensions", () => {
    expect(readAcpQuestions(undefined)).toBeNull();
    expect(readAcpQuestions({})).toBeNull();
    expect(readAcpQuestions({ "paseo/questions": [] })).toBeNull();
    expect(readAcpQuestions({ "paseo/questions": "nope" })).toBeNull();
    expect(
      readAcpQuestions({ "paseo/questions": [{ question: "no header", options: [] }] }),
    ).toBeNull();
    expect(readAcpQuestions({ "paseo/questions": [question, 3] })).toBeNull();
  });
});

describe("acpAnswersResponseMeta", () => {
  test("wraps the answers for the response _meta", () => {
    expect(acpAnswersResponseMeta({ answers: { Pick: "a, b" } })).toEqual({
      _meta: { "paseo/answers": { Pick: "a, b" } },
    });
  });

  test("adds nothing without answers", () => {
    expect(acpAnswersResponseMeta(undefined)).toEqual({});
    expect(acpAnswersResponseMeta({ answers: "x" })).toEqual({});
  });
});
