/** Timeline projection contracts (DOM-free parts of the dsh views spec).
 *
 * Retargeted from DeepSeek deepseek-harness `tests/views.client.spec.tsx`
 * (commit afd92680f2, MIT — Copyright (c) 2026 DeepSeek). Only the timeline
 * projection cases are kept here; the rendered-component cases live with the
 * RN renderer tests (T2.6).
 */

import { describe, expect, it } from "vitest";
import type { TrajectoryTurnModel } from "./layout.ts";
import { deriveTrajectoryTimeline, trajectoryTimelineFocusIndexes } from "./timeline.ts";

describe("deriveTrajectoryTimeline", () => {
  it("uses equal-width operation slots and stable semantic lanes", () => {
    const turns = [
      {
        turn: 1,
        groups: [
          {
            title: "Step 1",
            cells: [
              { index: 1, kind: "message" as const, text: "assistant", timeSeconds: 0 },
              { index: 2, kind: "tool" as const, text: "bash", timeSeconds: 0 },
              { index: 3, kind: "user" as const, text: "unknown", timeSeconds: 0 },
            ],
          },
        ],
      },
    ] satisfies readonly TrajectoryTurnModel[];

    expect(deriveTrajectoryTimeline(turns)).toEqual({
      start: 0,
      end: 3,
      spans: [
        {
          index: 1,
          isError: false,
          kind: "message",
          label: "assistant",
          lane: 1,
          start: 0,
          end: 1,
        },
        {
          index: 2,
          isError: false,
          kind: "tool",
          label: "bash",
          lane: 2,
          start: 1,
          end: 2,
        },
        {
          index: 3,
          isError: false,
          kind: "user",
          label: "unknown",
          lane: 0,
          start: 2,
          end: 3,
        },
      ],
      turnBoundaries: [{ turn: 1, time: 0 }],
    });
  });

  it("ignores durations and idle gaps while retaining turn boundaries (sequence)", () => {
    const separatedTurns = [
      {
        turn: 1,
        groups: [
          {
            title: "Step 1",
            cells: [
              {
                index: 1,
                kind: "message" as const,
                text: "first",
                startedAt: 1_000,
                timeSeconds: 1,
              },
              {
                index: 2,
                kind: "tool" as const,
                text: "within-turn gap",
                startedAt: 4_000,
                timeSeconds: 1,
              },
            ],
          },
        ],
      },
      {
        turn: 2,
        groups: [
          {
            title: "Step 1",
            cells: [
              {
                index: 3,
                kind: "message" as const,
                text: "after user idle",
                startedAt: 40_000,
                timeSeconds: 1,
              },
            ],
          },
        ],
      },
    ] satisfies readonly TrajectoryTurnModel[];

    expect(deriveTrajectoryTimeline(separatedTurns)).toMatchObject({
      start: 0,
      end: 3,
      spans: [
        { index: 1, start: 0, end: 1 },
        { index: 2, start: 1, end: 2 },
        { index: 3, start: 2, end: 3 },
      ],
      turnBoundaries: [
        { turn: 1, time: 0 },
        { turn: 2, time: 2 },
      ],
    });
  });

  it("compresses every idle gap in duration mode while actual mode retains wall time", () => {
    const separatedTurns = [
      {
        turn: 1,
        groups: [
          {
            title: "Step 1",
            cells: [
              {
                index: 1,
                kind: "message" as const,
                text: "first",
                startedAt: 1_000,
                timeSeconds: 1,
              },
              {
                index: 2,
                kind: "tool" as const,
                text: "within-turn gap",
                startedAt: 4_000,
                timeSeconds: 1,
              },
            ],
          },
        ],
      },
      {
        turn: 2,
        groups: [
          {
            title: "Step 1",
            cells: [
              {
                index: 3,
                kind: "message" as const,
                text: "after user idle",
                startedAt: 40_000,
                timeSeconds: 1,
              },
            ],
          },
        ],
      },
    ] satisfies readonly TrajectoryTurnModel[];

    expect(deriveTrajectoryTimeline(separatedTurns, "duration")).toMatchObject({
      start: 1_000,
      end: 4_000,
      spans: [
        { index: 1, start: 1_000, end: 2_000 },
        { index: 2, start: 2_000, end: 3_000 },
        { index: 3, start: 3_000, end: 4_000 },
      ],
      turnBoundaries: [
        { turn: 1, time: 1_000 },
        { turn: 2, time: 3_000 },
      ],
    });
    expect(deriveTrajectoryTimeline(separatedTurns, "actual")).toMatchObject({
      start: 1_000,
      end: 41_000,
      spans: [
        { index: 1, start: 1_000, end: 2_000 },
        { index: 2, start: 4_000, end: 5_000 },
        { index: 3, start: 40_000, end: 41_000 },
      ],
    });
  });

  it("projects between-turn compaction without inventing a turn boundary", () => {
    const withStandaloneCompaction = [
      {
        turn: 1,
        groups: [
          {
            title: "Step 1",
            cells: [{ index: 1, kind: "message" as const, text: "before", timeSeconds: 0 }],
          },
        ],
      },
      {
        turn: null,
        groups: [
          {
            title: "Compaction 3",
            cells: [{ index: 2, kind: "compacted" as const, text: "summary", timeSeconds: 0 }],
          },
        ],
      },
      {
        turn: 2,
        groups: [
          {
            title: "Step 1",
            cells: [{ index: 3, kind: "message" as const, text: "after", timeSeconds: 0 }],
          },
        ],
      },
    ] satisfies readonly TrajectoryTurnModel[];

    expect(deriveTrajectoryTimeline(withStandaloneCompaction)).toMatchObject({
      spans: [
        { index: 1, start: 0, end: 1 },
        { index: 2, start: 1, end: 2 },
        { index: 3, start: 2, end: 3 },
      ],
      turnBoundaries: [
        { turn: 1, time: 0 },
        { turn: 2, time: 2 },
      ],
    });
  });

  it("empty inputs produce no model", () => {
    expect(deriveTrajectoryTimeline([])).toBeNull();
  });

  it("focus indexes select spans overlapping the inclusive range", () => {
    const turns = [
      {
        turn: 1,
        groups: [
          {
            title: "Step 1",
            cells: [
              { index: 1, kind: "message" as const, text: "a", timeSeconds: 0 },
              { index: 2, kind: "tool" as const, text: "b", timeSeconds: 0 },
              { index: 3, kind: "user" as const, text: "c", timeSeconds: 0 },
            ],
          },
        ],
      },
    ] satisfies readonly TrajectoryTurnModel[];

    // Span 1 = [0,1], span 2 = [1,2], span 3 = [2,3]: the inclusive overlap
    // rule (start <= range.end && end >= range.start) touches all three.
    expect(trajectoryTimelineFocusIndexes(turns, { start: 1, end: 2 })).toEqual(new Set([1, 2, 3]));
    expect(trajectoryTimelineFocusIndexes(turns, { start: 1, end: 1 })).toEqual(new Set([1, 2]));
  });
});
