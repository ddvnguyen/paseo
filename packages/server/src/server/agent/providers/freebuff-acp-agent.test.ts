import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { deriveFeaturesFromACP } from "./acp-agent.js";
import {
  FREEBUFF_ACCOUNT_FEATURE_OPTION,
  FREEBUFF_CONFIRM_OPEN_FEATURE_OPTION,
  isFreebuffACPProviderId,
} from "./freebuff-acp-agent.js";

const configOptions: SessionConfigOption[] = [
  {
    id: "account",
    name: "Account",
    type: "select",
    currentValue: "current",
    options: [{ value: "current", name: "Duc · 20/25 left" }],
  },
  {
    id: "confirm_open",
    name: "Session open",
    type: "select",
    currentValue: "ask",
    options: [
      { value: "ask", name: "Ask before opening" },
      { value: "auto", name: "Open automatically" },
    ],
  },
] as SessionConfigOption[];

describe("Freebuff ACP features", () => {
  it("surfaces the account/quota line and the session-open switch as features", () => {
    const features = deriveFeaturesFromACP(configOptions, [
      FREEBUFF_ACCOUNT_FEATURE_OPTION,
      FREEBUFF_CONFIRM_OPEN_FEATURE_OPTION,
    ]);
    expect(features.map((feature) => feature.id)).toEqual(["account", "confirm_open"]);
    expect(features[0]).toMatchObject({
      type: "select",
      value: "current",
      options: [{ id: "current", label: "Duc · 20/25 left" }],
    });
    expect(features[1]).toMatchObject({ value: "ask" });
  });

  it("matches freebuff provider ids but not the OpenCode paid path", () => {
    expect(isFreebuffACPProviderId("freebuff")).toBe(true);
    expect(isFreebuffACPProviderId("freebuff-acct2")).toBe(true);
    expect(isFreebuffACPProviderId("freebuff-chat")).toBe(false);
  });
});
