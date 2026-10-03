/**
 * The wire contract, with the honesty rules as tests. These are the invariants
 * a later edit can only break on purpose.
 */

import { describe, expect, it } from "vitest";
import {
  CtxInjectChipDataSchema,
  CTX_INJECT_VERSION,
  EstimatedTokensSchema,
} from "./ctx-schema.js";

const BASE = {
  systemPromptInjected: true,
  systemPromptLength: 1234,
  systemPromptHash: "abcdef012345",
  mcpServers: ["github"],
  paseoToolsInjected: true,
  model: "claude-opus-5",
  modeId: "plan",
  reason: "create",
  capturedAt: "2026-09-27T00:00:00.000Z",
};

describe("EstimatedTokensSchema", () => {
  it("accepts an estimate that declares itself", () => {
    expect(EstimatedTokensSchema.parse({ tokens: 309, estimated: true })).toEqual({
      tokens: 309,
      estimated: true,
    });
  });

  it("refuses a count that claims to be measured", () => {
    // The flag is a literal, not a boolean: there is no way to publish a
    // "real" token count from this plugin, because it never sees the text.
    expect(EstimatedTokensSchema.safeParse({ tokens: 309, estimated: false }).success).toBe(false);
    expect(EstimatedTokensSchema.safeParse({ tokens: 309 }).success).toBe(false);
  });

  it("refuses a negative or fractional count", () => {
    expect(EstimatedTokensSchema.safeParse({ tokens: -1, estimated: true }).success).toBe(false);
    expect(EstimatedTokensSchema.safeParse({ tokens: 1.5, estimated: true }).success).toBe(false);
  });
});

describe("CtxInjectChipDataSchema", () => {
  it("parses a row carrying estimates", () => {
    const data = CtxInjectChipDataSchema.parse({
      ...BASE,
      tokenEstimates: { systemPrompt: { tokens: 309, estimated: true } },
    });

    expect(data.tokenEstimates?.systemPrompt?.tokens).toBe(309);
  });

  it("parses a row written before the field existed", () => {
    // Additive-optional is what lets CTX_INJECT_VERSION stay at 1 without
    // orphaning rows already persisted on disk.
    const data = CtxInjectChipDataSchema.parse(BASE);

    expect(data.tokenEstimates).toBeUndefined();
  });

  it("keeps a null estimate distinct from a zero one", () => {
    const data = CtxInjectChipDataSchema.parse({
      ...BASE,
      systemPromptInjected: null,
      systemPromptLength: null,
      systemPromptHash: null,
      tokenEstimates: { systemPrompt: null },
    });

    expect(data.tokenEstimates?.systemPrompt).toBeNull();
  });

  it("rejects an estimate that arrives unflagged", () => {
    expect(
      CtxInjectChipDataSchema.safeParse({
        ...BASE,
        tokenEstimates: { systemPrompt: { tokens: 309 } },
      }).success,
    ).toBe(false);
  });
});

describe("CTX_INJECT_VERSION", () => {
  it("stays 1 across the additive optional change", () => {
    // The host matches renderers on an EXACT version, so a bump here would stop
    // every persisted row rendering. Revisit only when a change is not additive.
    expect(CTX_INJECT_VERSION).toBe(1);
  });
});
