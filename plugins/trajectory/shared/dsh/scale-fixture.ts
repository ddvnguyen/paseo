/**
 * Scale fixtures for the data-plane ladder. Deterministic, allocation-heavy on
 * purpose: a fixture that reuses objects would hide exactly the costs being
 * measured.
 *
 * Ladder shape is a size ladder (turn count) at two cells-per-turn densities:
 * turns grow while steps-per-turn is held fixed, so it bounds the paths that are
 * already linear.
 */

import type { TrajectoryFoldRow } from "./layout.js";
import type { TrajectoryEvent } from "../trajectory.js";

const BASE_MS = Date.parse("2026-09-26T00:00:00Z");

/** Deterministic pseudo-text; long enough that search is not trivially short. */
function text(turn: number, step: number): string {
  return `turn ${turn} step ${step} did a thing with a moderately long label so string work is realistic`;
}

/**
 * `cellsPerTurn` counts the step rows. A turn is a user row, then that many
 * message/tool pairs, so a turn of density D yields 1 + 2D fold rows.
 */
export function scaleRows(turnCount: number, cellsPerTurn: number): TrajectoryFoldRow[] {
  const rows: TrajectoryFoldRow[] = [];
  let seq = 0;
  for (let turn = 1; turn <= turnCount; turn++) {
    const turnId = `t${turn}`;
    seq += 1;
    rows.push({
      seq,
      timeMs: BASE_MS + seq * 1_000,
      kind: "user",
      label: `turn ${turn} prompt`,
      durationMs: null,
      turnId,
      step: null,
    });
    for (let step = 1; step <= cellsPerTurn; step++) {
      seq += 1;
      rows.push({
        seq,
        timeMs: BASE_MS + seq * 1_000,
        kind: "message",
        label: text(turn, step),
        durationMs: 5,
        turnId,
        step,
      });
      seq += 1;
      rows.push({
        seq,
        timeMs: BASE_MS + seq * 1_000,
        kind: "tool",
        label: `shell · ${text(turn, step)}`,
        durationMs: 400,
        callId: `c${turn}-${step}`,
        turnId,
        step,
        outputChars: 1200,
      });
    }
  }
  return rows;
}

function eventType(kind: TrajectoryFoldRow["kind"]): TrajectoryEvent["type"] {
  if (kind === "tool") return "tool/call";
  if (kind === "user") return "user/message";
  return "assistant/message";
}

/** The same shape as raw ledger events, for eventsToFoldRows. */
export function scaleEvents(turnCount: number, cellsPerTurn: number): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = [];
  for (const row of scaleRows(turnCount, cellsPerTurn)) {
    events.push({
      seq: row.seq,
      time: new Date(row.timeMs ?? BASE_MS).toISOString(),
      type: eventType(row.kind),
      turn: row.turnId ?? null,
      step: row.step,
      agentId: "a1",
      data: { label: row.label, callId: row.callId ?? null, durationMs: row.durationMs },
    });
  }
  return events;
}

/** Turn numbers derived in order, matching the live path when none are supplied. */
export function turnNumbersFor(rows: readonly TrajectoryFoldRow[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const row of rows) {
    if (row.turnId === null || numbers.has(row.turnId)) continue;
    numbers.set(row.turnId, numbers.size + 1);
  }
  return numbers;
}
