/**
 * The duration formatter, with the tier boundaries and the floor rule as tests.
 *
 * Every duration label in the ledger — the STATS column, the inspector, the
 * strip tooltip, the group wall span — is this one function, so these cases are
 * the contract for all of them.
 */

import { describe, expect, it } from "vitest";
import { formatDurationMillis, formatElapsedSeconds } from "./record.js";

describe("formatDurationMillis tiers", () => {
  it("keeps milliseconds under a second", () => {
    expect(formatDurationMillis(0)).toBe("0 ms");
    expect(formatDurationMillis(130)).toBe("130 ms");
    expect(formatDurationMillis(999)).toBe("999 ms");
  });

  it("switches to whole seconds at a second", () => {
    expect(formatDurationMillis(1000)).toBe("1s");
    expect(formatDurationMillis(32_000)).toBe("32s");
    // Last millisecond label: 1,000ms of duration is one second of duration.
    expect(formatDurationMillis(999.9)).toBe("999 ms");
  });

  it("stays in seconds right up to the minute boundary", () => {
    expect(formatDurationMillis(59_999)).toBe("59s");
  });

  it("switches to minutes and seconds at a minute", () => {
    expect(formatDurationMillis(60_000)).toBe("1m0s");
    expect(formatDurationMillis(61_000)).toBe("1m1s");
    expect(formatDurationMillis(225_000)).toBe("3m45s");
  });
});

describe("formatDurationMillis floors to the display unit", () => {
  it("never rounds a duration up past what it took", () => {
    // The owner's examples: 32.4s is "32s" and 224.999s is "3m44s".
    expect(formatDurationMillis(32_400)).toBe("32s");
    expect(formatDurationMillis(224_999)).toBe("3m44s");
    // And the same rule in the millisecond tier, so a row just under a
    // boundary does not report the boundary it has not reached.
    expect(formatDurationMillis(1_999)).toBe("1s");
    expect(formatDurationMillis(129_999)).toBe("2m9s");
  });

  it("floors rather than rounds seconds inside a minute", () => {
    expect(formatDurationMillis(59_400)).toBe("59s");
    expect(formatDurationMillis(2_500)).toBe("2s");
  });
});

describe("formatDurationMillis unknown input", () => {
  it("renders an absent or non-finite duration as an em dash", () => {
    for (const input of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatDurationMillis(input)).toBe("—");
    }
  });

  it("renders a negative duration as unknown, not as a short one", () => {
    // A signed number among unsigned ones in a fixed column is worse than an
    // honest gap, and a negative duration means the data is wrong, not short.
    expect(formatDurationMillis(-1)).toBe("—");
    expect(formatDurationMillis(-32_000)).toBe("—");
  });
});

describe("formatElapsedSeconds", () => {
  it("shares the millisecond formatter's tiers", () => {
    // The STATS column and the group wall span arrive in seconds; a second set
    // of rules here would be exactly the drift the shared helper exists to stop.
    expect(formatElapsedSeconds(0.13)).toBe("130 ms");
    expect(formatElapsedSeconds(1.5)).toBe("1s");
    expect(formatElapsedSeconds(32)).toBe("32s");
    expect(formatElapsedSeconds(225)).toBe("3m45s");
    expect(formatElapsedSeconds(null)).toBe("—");
  });
});
