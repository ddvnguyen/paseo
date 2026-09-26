import { readFileSync } from "node:fs";
import path from "node:path";
import { AgentSideConnection, ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";

import {
  ACP_REQUIRE_APPROVAL_META_KEY,
  acpAnswersResponseMeta,
  readAcpQuestions,
  requiresExplicitApproval,
} from "./acp-questions.js";

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

describe("requiresExplicitApproval", () => {
  test("is true for the explicit flag", () => {
    expect(requiresExplicitApproval({ "paseo/requireApproval": true })).toBe(true);
  });

  test("fails closed for truthy non-boolean values", () => {
    expect(requiresExplicitApproval({ "paseo/requireApproval": "true" })).toBe(true);
    expect(requiresExplicitApproval({ "paseo/requireApproval": 1 })).toBe(true);
    expect(requiresExplicitApproval({ "paseo/requireApproval": {} })).toBe(true);
  });

  test("is false when absent, null, false, or _meta is not an object", () => {
    expect(requiresExplicitApproval(undefined)).toBe(false);
    expect(requiresExplicitApproval(null)).toBe(false);
    expect(requiresExplicitApproval("paseo/requireApproval")).toBe(false);
    expect(requiresExplicitApproval([true])).toBe(false);
    expect(requiresExplicitApproval({})).toBe(false);
    expect(requiresExplicitApproval({ "paseo/requireApproval": false })).toBe(false);
    expect(requiresExplicitApproval({ "paseo/requireApproval": null })).toBe(false);
  });

  test("applies together with paseo/questions", () => {
    const meta = { "paseo/questions": [question], "paseo/requireApproval": true };
    expect(readAcpQuestions(meta)).toEqual([question]);
    expect(requiresExplicitApproval(meta)).toBe(true);
  });
});

describe("paseo/requireApproval wire contract", () => {
  test("the freebuff-acp adapter sends the exact key the host reads", () => {
    const adapterSource = readFileSync(
      path.resolve(__dirname, "../../../../../freebuff-acp/src/permission-meta.ts"),
      "utf8",
    );
    expect(adapterSource).toContain(
      `REQUIRE_APPROVAL_META_KEY = "${ACP_REQUIRE_APPROVAL_META_KEY}"`,
    );
  });

  test("_meta survives the ACP ndjson transport to the host client", async () => {
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    let received: unknown;
    const agentSide = new AgentSideConnection(
      () => ({
        async initialize() {
          return { protocolVersion: 1, agentCapabilities: {} };
        },
        async newSession() {
          return { sessionId: "s" };
        },
        async prompt() {
          return { stopReason: "end_turn" as const };
        },
        async authenticate() {},
        async cancel() {},
      }),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );
    const clientSide = new ClientSideConnection(
      () => ({
        async requestPermission(params) {
          received = params._meta;
          return { outcome: { outcome: "cancelled" as const } };
        },
        async sessionUpdate() {},
      }),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );

    await agentSide.requestPermission({
      sessionId: "s",
      _meta: { [ACP_REQUIRE_APPROVAL_META_KEY]: true },
      toolCall: { toolCallId: "t", title: "Open", status: "pending" },
      options: [{ kind: "allow_once", name: "Open", optionId: "open" }],
    });

    expect(requiresExplicitApproval(received)).toBe(true);
    expect(clientSide.signal.aborted).toBe(false);
  });
});
