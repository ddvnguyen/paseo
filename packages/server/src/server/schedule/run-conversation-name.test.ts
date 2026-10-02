import { describe, expect, test } from "vitest";
import { formatRunConversationName, isRunConversationName } from "./run-conversation-name.js";

describe("formatRunConversationName", () => {
  test("renders the run ordinal and the dispatch hour", () => {
    expect(formatRunConversationName(1, new Date("2026-10-02T01:30:00.000Z"), "UTC")).toBe(
      "#1 - 261002-01",
    );
  });

  test("renders a 37th run", () => {
    expect(formatRunConversationName(37, new Date("2026-10-02T01:30:00.000Z"), "UTC")).toBe(
      "#37 - 261002-01",
    );
  });

  test("zero-pads every field, including single-digit hours", () => {
    expect(formatRunConversationName(8, new Date("2027-01-09T03:00:00.000Z"), "UTC")).toBe(
      "#8 - 270109-03",
    );
  });

  test("uses the schedule timezone's hour, not the dispatching daemon's", () => {
    // 18:30Z is 01:30 the next day in Bangkok (+07). A daemon running in UTC would
    // otherwise stamp this `261003-18` and the user would not recognise it.
    expect(
      formatRunConversationName(12, new Date("2026-10-02T18:30:00.000Z"), "Asia/Bangkok"),
    ).toBe("#12 - 261003-01");
  });

  test("honours a timezone that is behind UTC", () => {
    expect(
      formatRunConversationName(2, new Date("2026-10-02T02:30:00.000Z"), "America/Denver"),
    ).toBe("#2 - 261001-20");
  });

  test("reads the daemon's local time when the schedule has no timezone", () => {
    // Pinned to UTC fields so the expectation is stable wherever the suite runs,
    // and asserted through the same formatter the naming path uses.
    const at = new Date("2026-10-02T01:30:00.000Z");
    const localHour = String(at.getHours()).padStart(2, "0");
    expect(formatRunConversationName(1, at)).toBe(
      `#1 - ${String(at.getFullYear() % 100).padStart(2, "0")}${String(at.getMonth() + 1).padStart(2, "0")}${String(at.getDate()).padStart(2, "0")}-${localHour}`,
    );
  });

  test("keeps midnight at 00 instead of rolling it to 24", () => {
    expect(formatRunConversationName(1, new Date("2026-10-02T00:05:00.000Z"), "UTC")).toBe(
      "#1 - 261002-00",
    );
  });

  test("rejects an ordinal that is not a positive integer", () => {
    const at = new Date("2026-10-02T01:30:00.000Z");
    expect(() => formatRunConversationName(0, at, "UTC")).toThrow(
      "Schedule run conversation name needs a 1-based ordinal, got: 0",
    );
    expect(() => formatRunConversationName(-1, at, "UTC")).toThrow(/1-based ordinal/);
    expect(() => formatRunConversationName(1.5, at, "UTC")).toThrow(/1-based ordinal/);
  });
});

describe("isRunConversationName", () => {
  test("recognises a formatted dispatch name", () => {
    expect(isRunConversationName("#37 - 261002-01")).toBe(true);
    expect(isRunConversationName("#1 - 270109-00")).toBe(true);
  });

  test("rejects a generated or user title", () => {
    expect(isRunConversationName("Audit flaky checkout flow")).toBe(false);
    expect(isRunConversationName("deploy-collector")).toBe(false);
    expect(isRunConversationName("#37 - 261002")).toBe(false);
    expect(isRunConversationName("#37-261002-01")).toBe(false);
    expect(isRunConversationName("# 37 - 261002-01")).toBe(false);
    expect(isRunConversationName(null)).toBe(false);
    expect(isRunConversationName(undefined)).toBe(false);
  });
});
