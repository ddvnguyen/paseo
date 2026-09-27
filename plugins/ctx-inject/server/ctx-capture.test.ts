/** Capture contract for the context-inject chip, with the privacy rules as tests. */

import { describe, expect, it } from "vitest";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import {
  buildChipData,
  configFacts,
  HASH_CHARS,
  MCP_NAMES_MAX,
  systemPromptHash,
  type ConfigFacts,
} from "./ctx-capture.js";

const SECRET = "sk-live-DO-NOT-LEAK-9f3a2b";

function config(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return { provider: "claude", ...overrides } as AgentSessionConfig;
}

const FACTS: ConfigFacts = {
  systemPromptInjected: true,
  systemPromptLength: 12,
  systemPromptHash: "abcdef012345",
  mcpServers: ["github"],
  model: "claude-opus-5",
  modeId: "plan",
};

describe("configFacts model and mode", () => {
  // QC round 9 defect: model/mode attach to the agent record AFTER agent.created,
  // so a snapshot read there produced em dashes. The create config carries them.
  it("captures model and mode as configured at create time", () => {
    const facts = configFacts(config({ model: "space-bunny-free", modeId: "auto" }));

    expect(facts.model).toBe("space-bunny-free");
    expect(facts.modeId).toBe("auto");
  });

  it("leaves model and mode unknown when the config omits them", () => {
    const facts = configFacts(config());

    expect(facts.model).toBeNull();
    expect(facts.modeId).toBeNull();
  });
});

describe("systemPromptHash", () => {
  it("is a stable 12-char digest that differs per prompt", () => {
    const first = systemPromptHash("hello world");
    expect(first).toHaveLength(HASH_CHARS);
    expect(first).toBe(systemPromptHash("hello world"));
    expect(first).not.toBe(systemPromptHash("hello worlds"));
  });
});

describe("configFacts", () => {
  it("reduces a configured prompt to length and hash only", () => {
    const facts = configFacts(config({ systemPrompt: SECRET }));

    expect(facts.systemPromptInjected).toBe(true);
    expect(facts.systemPromptLength).toBe(SECRET.length);
    expect(facts.systemPromptHash).toBe(systemPromptHash(SECRET));
  });

  it("never carries prompt text into any captured field", () => {
    const facts = configFacts(config({ systemPrompt: SECRET }));

    // The row is persisted and relayed chat history, so the reduction has to hold
    // for the whole object, not just the field we happen to be reading.
    expect(JSON.stringify(facts)).not.toContain(SECRET);
    expect(JSON.stringify(facts)).not.toContain("DO-NOT-LEAK");
  });

  it("treats an absent, empty, or missing config as no prompt", () => {
    for (const input of [config(), config({ systemPrompt: "" }), null, undefined]) {
      const facts = configFacts(input);
      expect(facts).toMatchObject({
        systemPromptInjected: false,
        systemPromptLength: 0,
        systemPromptHash: null,
      });
    }
  });

  it("captures MCP server names only, sorted, and never their config", () => {
    const facts = configFacts(
      config({
        mcpServers: {
          zebra: { command: SECRET },
          alpha: { url: `https://example.invalid/${SECRET}` },
        },
      } as unknown as AgentSessionConfig),
    );

    expect(facts.mcpServers).toEqual(["alpha", "zebra"]);
    // Commands and URLs are exactly where MCP secrets live.
    expect(JSON.stringify(facts)).not.toContain(SECRET);
  });

  it("caps the MCP name list so a pathological config cannot bloat the row", () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < MCP_NAMES_MAX + 20; i += 1) many[`server-${i}`] = {};
    const facts = configFacts(config({ mcpServers: many } as unknown as AgentSessionConfig));

    expect(facts.mcpServers).toHaveLength(MCP_NAMES_MAX);
  });
});

describe("buildChipData", () => {
  it("merges create facts with the agent snapshot", () => {
    const data = buildChipData({
      facts: FACTS,
      snapshot: { model: "claude-opus-5", currentModeId: "plan" },
      paseoToolsInjected: true,
      reason: "create",
      capturedAt: "2026-09-27T00:00:00.000Z",
    });

    expect(data).toEqual({
      systemPromptInjected: true,
      systemPromptLength: 12,
      systemPromptHash: "abcdef012345",
      mcpServers: ["github"],
      paseoToolsInjected: true,
      model: "claude-opus-5",
      modeId: "plan",
      reason: "create",
      capturedAt: "2026-09-27T00:00:00.000Z",
    });
  });

  it("nulls the prompt facts when no create hook was correlated (resume)", () => {
    // A resumed agent never ran the create hook, so "unknown" must not be
    // rendered as "no prompt configured" — that would be a fabricated fact.
    const data = buildChipData({
      facts: null,
      snapshot: null,
      paseoToolsInjected: null,
      reason: "resume",
      capturedAt: "2026-09-27T00:00:00.000Z",
    });

    expect(data).toMatchObject({
      systemPromptInjected: null,
      systemPromptLength: null,
      systemPromptHash: null,
      mcpServers: [],
      model: null,
      modeId: null,
      reason: "resume",
    });
  });

  it("keeps an unreadable paseo-tools flag unknown rather than false", () => {
    const data = buildChipData({
      facts: FACTS,
      snapshot: null,
      paseoToolsInjected: null,
      reason: "create",
      capturedAt: "2026-09-27T00:00:00.000Z",
    });

    expect(data.paseoToolsInjected).toBeNull();
  });

  it("prefers the configured model/mode over a later snapshot change", () => {
    // The row documents what the session was created with; a snapshot read at
    // flush time may already differ, and must not silently rewrite the record.
    const data = buildChipData({
      facts: FACTS,
      snapshot: { model: "some-other-model", currentModeId: "bypass" },
      paseoToolsInjected: true,
      reason: "create",
      capturedAt: "2026-09-27T00:00:00.000Z",
    });

    expect(data.model).toBe("claude-opus-5");
    expect(data.modeId).toBe("plan");
  });

  it("falls back to the live snapshot when no create hook was correlated", () => {
    const data = buildChipData({
      facts: null,
      snapshot: { model: "space-bunny-free", currentModeId: "auto" },
      paseoToolsInjected: true,
      reason: "resume",
      capturedAt: "2026-09-27T00:00:00.000Z",
    });

    expect(data.model).toBe("space-bunny-free");
    expect(data.modeId).toBe("auto");
  });
});
