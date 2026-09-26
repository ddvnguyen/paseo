/** Search index contracts (ported from the dsh ui-trajectory suite).
 *
 * Upstream dsh covers the index inside views.client.spec.tsx via the rendered
 * view; these are the same contracts expressed directly over the ported class.
 */

import { describe, expect, it } from "vitest";
import { deriveTrajectoryLayout, type TrajectoryFoldRow } from "./layout.ts";
import { TrajectorySearchIndex } from "./search-index.ts";

let seq = 0;
function row(
  overrides: Partial<TrajectoryFoldRow> & { kind: TrajectoryFoldRow["kind"] },
): TrajectoryFoldRow {
  seq += 1;
  return {
    seq,
    timeMs: Date.parse("2026-09-26T00:00:00Z") + seq * 1_000,
    kind: overrides.kind,
    label: "unknown",
    durationMs: null,
    turnId: "t1",
    step: null,
    ...overrides,
  };
}

describe("TrajectorySearchIndex", () => {
  it("matches records by term across kind, label, and group", () => {
    const turns = deriveTrajectoryLayout({
      rows: [
        row({ kind: "user", label: "fix the login bug" }),
        row({ kind: "message", turnId: "t1", step: 1, label: "assistant message (10 chars)" }),
        row({ kind: "tool", turnId: "t1", step: 1, label: "shell · npm test", callId: "c1" }),
      ],
    });
    const index = new TrajectorySearchIndex();
    expect(index.update([turns])).toBe(true);
    expect(index.search("login")).not.toBeNull();
    expect(index.search("login")?.size).toBe(1);
    expect(index.search("shell")?.size).toBe(1);
    expect(index.search("assistant")?.size).toBe(1);
  });

  it("requires every whitespace-separated term (AND semantics), case-insensitive", () => {
    const turns = deriveTrajectoryLayout({
      rows: [row({ kind: "tool", turnId: "t1", step: 1, label: "Shell · NPM Test", callId: "c1" })],
    });
    const index = new TrajectorySearchIndex();
    index.update([turns]);
    expect(index.search("shell npm")?.size).toBe(1);
    expect(index.search("shell nope")?.size).toBe(0);
  });

  it("returns null without a query", () => {
    const turns = deriveTrajectoryLayout({ rows: [row({ kind: "user", label: "x" })] });
    const index = new TrajectorySearchIndex();
    index.update([turns]);
    expect(index.search("")).toBeNull();
    expect(index.search("   ")).toBeNull();
  });

  it("does not reparse unchanged records on repeated updates", () => {
    const rows = [row({ kind: "user", label: "stable" })];
    const turns = deriveTrajectoryLayout({ rows });
    const index = new TrajectorySearchIndex();
    expect(index.update([turns])).toBe(true);
    // Same array reference: the index short-circuits without rescanning.
    expect(index.update([turns])).toBe(false);
    // Re-derived (fresh array) layout rescans but keeps entries stable.
    const again = deriveTrajectoryLayout({ rows });
    expect(index.update([again])).toBe(true);
    expect(index.search("stable")?.size).toBe(1);
  });

  it("evicts entries for records that disappeared", () => {
    const before = deriveTrajectoryLayout({
      rows: [row({ kind: "user", label: "gone" }), row({ kind: "user", label: "stays" })],
    });
    const after = deriveTrajectoryLayout({
      rows: [row({ kind: "user", label: "stays" })],
    });
    const index = new TrajectorySearchIndex();
    index.update([before]);
    expect(index.search("gone")?.size).toBe(1);
    index.update([after]);
    expect(index.search("gone")?.size).toBe(0);
    expect(index.search("stays")?.size).toBe(1);
  });
});
