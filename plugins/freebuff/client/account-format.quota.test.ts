import { describe, expect, it } from "vitest";

import { quotaSummaryLine } from "./account-format";

function account(
  status: Record<string, unknown> | null,
  authenticated = true,
): Parameters<typeof quotaSummaryLine>[0] {
  return {
    id: "work",
    label: "Work",
    authenticated,
    status: status as never,
  };
}

describe("quotaSummaryLine (owner directive: single line)", () => {
  it("joins percent, daily ratio, and reset on one line", () => {
    const line = quotaSummaryLine(
      account({ dailyRemaining: 0, dailyLimit: 25, resetAt: "2026-09-27T05:00:00.000Z" }),
    );
    expect(line).toMatch(/^100% used · 0\/25 daily · Resets \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);
    // No newline, single line.
    expect(line.includes("\n")).toBe(false);
  });

  it("shows partial usage and omits reset when absent", () => {
    expect(quotaSummaryLine(account({ dailyRemaining: 20, dailyLimit: 25 }))).toBe(
      "20% used · 20/25 daily",
    );
  });

  it("omits the percent when the limit is unknown", () => {
    expect(quotaSummaryLine(account({ dailyRemaining: 20 }))).toBe("20/? daily");
  });

  it("falls back cleanly when quota is unavailable or logged out", () => {
    expect(quotaSummaryLine(account(null))).toBe("Quota unavailable");
    expect(quotaSummaryLine(account({ dailyRemaining: 5, dailyLimit: 25 }, false))).toBe(
      "Not logged in",
    );
  });
});
