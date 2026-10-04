/** Pure projection from trajectory records to measurable virtual ledger rows.
 *
 * Ported from DeepSeek deepseek-harness `packages/client/ui-trajectory/src/client/trajectory-virtual-rows.ts`
 * (llm-server-monitoring repo, commit afd92680f2, MIT License — Copyright (c) 2026 DeepSeek).
 * Change from upstream: none (already DOM-free; heights are used by the RN
 * FlatList getItemLayout exactly as the dsh web virtualizer used them).
 */

import type { TrajectoryCellProps } from "./record.ts";
import { trajectoryRecordId } from "./record.ts";

/**
 * CONTENT_ROW_HEIGHT is measured: 31 CSS px, not the 30 that was ported from
 * dsh. The cell is `minHeight: 30` with a 1px border, and it was measured on
 * the item WRAPPER VirtualizedList positions — not the inner elements, which
 * can be a pixel or two shorter than the box the list lays out — in Chromium
 * 149 against the real react-native-web tree, at 1280px and 390px, compact and
 * not, with short and 190-character labels. Identical in all six, because the
 * cell text is single-line clamped.
 *
 * jsdom cannot do this measurement: react-native-web's VirtualizedList returns
 * early while visibleLength/contentLength are 0 and jsdom never sets them, so
 * a window or an offset measured there is fiction.
 *
 * The other two are UNREACHABLE in this plugin and therefore unmeasured: no
 * producer anywhere sets `collapsedSummaryKind` or `requestOnly`, so
 * `trajectory.list` never yields one of those rows and getItemLayout is never
 * asked for them. They are left at the ported dsh values rather than replaced
 * with a guess; if a producer ever sets those fields, measure them first.
 */
const CONTENT_ROW_HEIGHT = 31;
const COLLAPSED_SUMMARY_HEIGHT = 20;
const TERMINAL_BOUNDARY_HEIGHT = 9;

/** Minimal record shape required by the trajectory virtual-row projection. */
export interface VirtualizableTrajectoryRecord {
  cell: TrajectoryCellProps;
  collapsedSummaryKind?: "turn" | "assistant";
}

/** One logical record retained inside a measurable virtual row. */
export interface TrajectoryVirtualRowEntry<T extends VirtualizableTrajectoryRecord> {
  logicalIndex: number;
  record: T;
}

/** One virtualizer item, which may carry zero-height request boundaries. */
export interface TrajectoryVirtualRow<T extends VirtualizableTrajectoryRecord> {
  entries: readonly TrajectoryVirtualRowEntry<T>[];
  height: number;
  key: string;
}

/**
 * Derive the row identity shared by React, the virtualizer, and scroll
 * contracts. Safe for React Native keys (URI-encoded, no raw separators).
 * @param record - Display record whose identity is required.
 * @returns Stable record identity with a suffix for synthetic fold summaries.
 */
export function trajectoryVirtualRecordKey(record: VirtualizableTrajectoryRecord): string {
  const identity = encodeURIComponent(trajectoryRecordId(record.cell));
  return record.collapsedSummaryKind === undefined
    ? identity
    : `${identity}\u0000summary\u0000${record.collapsedSummaryKind}`;
}

/**
 * Attach separator-only records to the next content row so the virtualizer
 * never owns a zero-height item. A terminal separator retains its
 * lower-marker clearance as a standalone item.
 * @param records - Final search/fold projection in ledger order.
 * @returns Measurable virtual rows with original logical positions retained.
 */
export function groupTrajectoryVirtualRows<T extends VirtualizableTrajectoryRecord>(
  records: readonly T[],
): readonly TrajectoryVirtualRow<T>[] {
  const rows: TrajectoryVirtualRow<T>[] = [];
  let pending: TrajectoryVirtualRowEntry<T>[] = [];

  for (const [logicalIndex, record] of records.entries()) {
    const entry = { logicalIndex, record };
    if (record.cell.requestOnly === true) {
      pending.push(entry);
      continue;
    }
    const entries = [...pending, entry];
    pending = [];
    rows.push({
      entries,
      height:
        record.collapsedSummaryKind === undefined ? CONTENT_ROW_HEIGHT : COLLAPSED_SUMMARY_HEIGHT,
      key: trajectoryVirtualRecordKey(record),
    });
  }

  if (pending.length > 0) {
    rows.push({
      entries: pending,
      height: TERMINAL_BOUNDARY_HEIGHT,
      key: pending.map((candidate) => trajectoryVirtualRecordKey(candidate.record)).join("|"),
    });
  }

  return rows;
}
