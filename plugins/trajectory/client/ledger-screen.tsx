import { memo, useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { deriveTrajectoryLayout } from "../shared/dsh/layout.js";
import type { TrajectoryFoldRow, TrajectoryTurnModel } from "../shared/dsh/layout.js";
import { groupTrajectoryVirtualRows } from "../shared/dsh/virtual-rows.js";
import { TrajectorySearchIndex } from "../shared/dsh/search-index.js";
import { trajectoryRecordId, type TrajectoryCellProps } from "../shared/dsh/record.js";
import { LedgerColumnHeader, TrajectoryCellRow } from "./ledger-cells.js";
import { TrajectoryTimelineStrip, type TimelinePlatform } from "./trajectory-timeline.js";

/**
 * Trajectory ledger screen: FlatList over the ported virtual-row projection of
 * the ported layout fold, laid out as a four-column virtual table (TIME | TYPE |
 * CONTEXT | STATS) under a sticky column header. Turn headers fold and unfold,
 * cells sit directly under them, and a heavier rule separates turns; tail-follow
 * engages only when the list is at the bottom. `compact` (phone) collapses kind
 * tags to icons and tightens paddings. Data comes from `rows` via
 * useTrajectoryDelta.
 */

/**
 * Which turn numbers the user has COLLAPSED. Everything else is open.
 *
 * The state tracks the exception, not the rule, because turns stream in live and
 * turn numbers are positional (1..N as they arrive). An "open" set seeded at
 * mount would leave every turn that arrives afterwards collapsed, which is the
 * opposite of what a live ledger wants. With closed-turns tracked instead, a
 * turn appended after mount is expanded until the user says otherwise, and a
 * manual collapse survives later appends because it is keyed by turn number.
 */
interface FoldState {
  /** Turn numbers the user collapsed; absent means open. */
  closedTurns: ReadonlySet<number>;
}

/** Nothing collapsed: every turn expanded, including ones not yet recorded. */
const ALL_OPEN: FoldState = { closedTurns: new Set() };

export function LedgerScreen(props: {
  rows: readonly TrajectoryFoldRow[];
  turnNumbers?: ReadonlyMap<string, number>;
  openCallIds?: ReadonlySet<string>;
  compact: boolean;
  theme: PluginTheme;
  onCellPress?: (cell: TrajectoryCellProps) => void;
  /**
   * Text fetched on demand for a cell, or undefined when unresolved/unkeyable.
   * The row then keeps its `(N chars)` label — a normal state, not an error.
   */
  textFor?: (cell: TrajectoryCellProps) => string | undefined;
  /** Reports the cells actually on screen so only those are resolved. */
  onVisibleCells?: (cells: readonly TrajectoryCellProps[]) => void;
  /**
   * Source seq of the open inspector's row. Optional: the strip outlines the
   * matching bar when it is given, and highlights nothing when it is not.
   */
  selectedSeq?: number | null;
  /** Called when a timeline bar is pressed, with that record's source seq. */
  onSelectSpan?: (sourceSeq: number) => void;
  /**
   * Dismiss the host dialog from the toolbar's close control. Optional: an older
   * host supplies no callback and the control is not rendered at all, rather than
   * rendering a button that cannot do anything.
   */
  onClose?: (() => void) | undefined;
  /**
   * Which surface this is, from the host's layout contract. Drives whether the
   * strip's tooltip is hover-driven or tap-driven; omitted means tap-only.
   */
  platform?: TimelinePlatform;
  testID?: string;
}) {
  const {
    rows,
    turnNumbers,
    openCallIds,
    compact,
    theme,
    onCellPress,
    textFor,
    onVisibleCells,
    selectedSeq,
    onSelectSpan,
    onClose,
    platform,
    testID,
  } = props;
  const [fold, setFold] = useState<FoldState>(ALL_OPEN);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const listRef = useRef<FlatList<ListRow> | null>(null);

  const turns = useMemo(
    () => deriveTrajectoryLayout({ rows, turnNumbers, openCallIds }),
    [rows, turnNumbers, openCallIds],
  );

  // Everything open, as a fold state. Shared by the "unfold all" action and by an
  // active search, which must not leave a match stranded behind a collapsed header.
  const allOpen = useMemo<FoldState>(() => ALL_OPEN, []);

  // View-local incremental index: it re-parses a record only when that record's
  // sources change, so live appends stay cheap. Always fed the UNFILTERED layout,
  // so a query can never narrow what a later query can match.
  const indexRef = useRef<TrajectorySearchIndex | null>(null);
  if (indexRef.current === null) indexRef.current = new TrajectorySearchIndex();
  const matches = useMemo(() => {
    const index = indexRef.current;
    if (index === null) return null;
    index.update([turns]);
    return index.search(query);
  }, [turns, query]);

  // A match inside a collapsed turn would be unreachable, so an active search
  // forces the fold open rather than hiding results behind a header.
  const effectiveFold = matches === null ? fold : allOpen;
  const visibleTurns = useMemo(
    () => (matches === null ? turns : filterTurnsByMatch(turns, matches)),
    [turns, matches],
  );
  const records = useMemo(
    () => expandTurns(visibleTurns, effectiveFold, matches !== null),
    [visibleTurns, effectiveFold, matches],
  );

  /**
   * Cells go through the ported virtual-row projection (zero-height request
   * boundaries attach forward, keys stable); chrome records (headers, rules)
   * join the same FlatList data with their own keys and heights.
   */
  const virtualRows = useMemo(() => {
    // Cell position in the interleaved sequence -> its virtual row. Cells are
    // keyed by cell.index (dsh record identity), NOT by list position: chrome
    // rows interleave at arbitrary positions and consumed rows must be
    // dropped so a following step header cannot re-emit its row.
    const cellRecords = records.filter(
      (record): record is Extract<LeadRecord, { __kind: "cell" }> => record.__kind === "cell",
    );
    const cellRows = groupTrajectoryVirtualRows(cellRecords);
    const consumed = new Set<string>();
    const cellRowByCellIndex = new Map<number, (typeof cellRows)[number]>();
    for (const row of cellRows) {
      for (const entry of row.entries) {
        cellRowByCellIndex.set(entry.record.cell.index, row);
      }
    }
    const out: ListRow[] = [];
    for (const record of records) {
      if (record.__kind !== "cell") {
        const key = chromeKey(record);
        const height = record.__kind === "turn-header" ? 28 : 10;
        out.push({ kind: "chrome", key, height, record });
        continue;
      }
      const cellRow = cellRowByCellIndex.get(record.cell.index);
      if (cellRow === undefined || consumed.has(cellRow.key)) continue;
      consumed.add(cellRow.key);
      out.push({
        kind: "cellrow",
        key: cellRow.key,
        height: cellRow.height,
        cells: cellRow.entries.map((entry) => entry.record.cell),
      });
    }
    return out;
  }, [records]);

  const toggleTurn = useCallback((turn: number) => {
    setFold((previous) => {
      const closedTurns = new Set(previous.closedTurns);
      if (closedTurns.has(turn)) closedTurns.delete(turn);
      else closedTurns.add(turn);
      return { closedTurns };
    });
  }, []);

  const onQueryChange = useCallback((value: string) => setQuery(value), []);

  const handlers = useMemo(
    () => ({
      toggleTurn,
      pressCell:
        onCellPress === undefined
          ? undefined
          : (cell: TrajectoryCellProps) => {
              onCellPress(cell);
            },
    }),
    [toggleTurn, onCellPress],
  );

  const renderItem = useCallback(
    ({ item }: { item: ListRow }) => (
      <VirtualLedgerRow
        row={item}
        compact={compact}
        theme={theme}
        handlers={handlers}
        textFor={textFor}
      />
    ),
    [compact, theme, handlers, textFor],
  );

  /**
   * Only the rows the list is actually showing are worth resolving, so the
   * viewable window is reported upward. `viewabilityConfigCallback` pairs with
   * it: FlatList requires both to be stable identities.
   */
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 });
  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ item?: ListRow }> }) => {
      if (onVisibleCells === undefined) return;
      const cells: TrajectoryCellProps[] = [];
      for (const entry of viewableItems) {
        if (entry.item?.kind === "cellrow") cells.push(...entry.item.cells);
      }
      onVisibleCells(cells);
    },
  );

  const keyExtractor = useCallback((item: ListRow) => item.key, []);

  const onContentSizeChange = useCallback(() => {
    if (follow && listRef.current !== null) {
      listRef.current.scrollToEnd({ animated: false });
    }
  }, [follow]);

  const onScroll = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: { y: number };
        contentSize: { height: number };
        layoutMeasurement: { height: number };
      };
    }) => {
      const { y, height: contentHeight } = event.nativeEvent.contentSize
        ? { y: event.nativeEvent.contentOffset.y, height: event.nativeEvent.contentSize.height }
        : { y: 0, height: 0 };
      const viewport = event.nativeEvent.layoutMeasurement.height;
      const atBottom = y + viewport >= contentHeight - 24;
      setFollow(atBottom);
    },
    [],
  );

  return (
    <View style={screenStyles(theme)} testID={testID ?? "ledger-screen"}>
      <Toolbar
        compact={compact}
        theme={theme}
        query={query}
        onClose={onClose}
        onQueryChange={onQueryChange}
      />
      <LedgerColumnHeader compact={compact} theme={theme} />
      <TrajectoryTimelineStrip
        turns={visibleTurns}
        // The toolbar's Duration toggle is gone (owner T4 item 2), so the strip
        // stays on its default `sequence` projection: every record gets an equal
        // slot in arrival order, which is what makes the strip readable as an
        // overview. Mode switching, if it ever returns, belongs to the strip.
        actualDuration={false}
        compact={compact}
        theme={theme}
        selectedSeq={selectedSeq}
        onSelectSpan={onSelectSpan}
        platform={platform}
      />
      <FlatList
        ref={listRef}
        data={virtualRows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        onViewableItemsChanged={onViewableItemsChanged.current}
        viewabilityConfig={viewabilityConfig.current}
        initialNumToRender={24}
        testID="ledger-list"
      />
    </View>
  );
}

/**
 * Toolbar: a search box and the dialog's close control. One row on every form
 * factor, phone included — the field takes the slack and the X keeps its box.
 *
 * Owner T4 items 1-2, T8. The Duration and Turns chips are gone — the Duration
 * chip was the only way to reach the strip's other projection, and folding turns
 * one header at a time is what a reader of a live ledger actually wants. The
 * close X sits at the row's trailing edge, on the bar's own padding rail.
 *
 * This is the ONLY close control the dialog draws. It is not a sticky toolbar
 * that can scroll away — the bar is a sibling of the FlatList, not a list header
 * — so it is on screen for the whole session, and the notice states (which have
 * no toolbar) carry their own. The host's floating sheet close therefore has
 * nothing left to cover, and leaving it on produced a second X on a phone:
 * edge-to-edge puts that control at insets.top + 12, which is BELOW this
 * flush-at-0,0 row, so it landed on the column header and the sequence strip.
 *
 * The X is chrome, so it is ghost: no border, no fill, and the only state is the
 * glyph's colour, exactly as the host's own sheet close does it. It is never
 * hover-dependent, so there is nothing to reveal on touch.
 *
 * The close callback is OPTIONAL: a host that predates it supplies nothing, and
 * a button that cannot do anything is worse than no button, so the control is
 * not rendered at all.
 *
 * Plain objects, not StyleSheet.create: these carry theme colors, and the
 * themed-factory form re-registers styles on every theme (the c05e19c24
 * react-native-web WeakMap hazard).
 */
function Toolbar(props: {
  compact: boolean;
  theme: PluginTheme;
  query: string;
  /** Dismiss the host dialog; absent on older hosts, which hides the control. */
  onClose?: (() => void) | undefined;
  onQueryChange: (value: string) => void;
}) {
  const { compact, theme, query, onClose, onQueryChange } = props;
  const styles = useMemo(() => toolbarStyles(theme, compact), [theme, compact]);
  return (
    <View style={styles.bar} testID="ledger-toolbar">
      <View style={styles.search}>
        <TextInput
          value={query}
          onChangeText={onQueryChange}
          placeholder="Search"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="Search trajectory"
          style={styles.searchInput}
          testID="ledger-search"
        />
      </View>
      {onClose === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close trajectory"
          hitSlop={CLOSE_HIT_SLOP}
          onPress={onClose}
          style={styles.close}
          testID="trajectory-toolbar-close"
        >
          {({ pressed }) => (
            <Text style={pressed ? styles.closeGlyphOn : styles.closeGlyph}>✕</Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

/** Painted box of the toolbar close; a touch wider than the search field so the ✕ has air. */
const CLOSE_PAINTED = 26;
/**
 * Minimum comfortable target, matching the inspector's close and the host
 * sheet's own floor for its close control. `hitSlop` grows the touch/hit rect
 * without touching layout or paint, so the painted box stays compact.
 */
const CLOSE_TARGET = 44;
const CLOSE_HIT_SLOP = (CLOSE_TARGET - CLOSE_PAINTED) / 2;

function toolbarStyles(theme: PluginTheme, compact: boolean) {
  // Optical, not arithmetic: the ✕ glyph's box is not its stroke's, so it sits a
  // hair left of centre in a square button. Nudge, don't measure.
  const closeGlyph: TextStyle = {
    marginLeft: -1,
    color: theme.colors.foregroundMuted,
    fontSize: 13,
    lineHeight: 15,
  };
  return {
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 6,
      paddingVertical: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    } satisfies ViewStyle,
    search: {
      flex: 1,
      // The pair that keeps this ONE row at phone widths: a CSS flex item
      // defaults to min-width: auto, so without minWidth 0 the field cannot
      // shrink below its content and pushes the X off the row (the same
      // flex-shrink/min-width hazard docs/design.md §8 and the ctx-inject chip
      // both call out). flexShrink 0 on the X below is the other half.
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      height: 22,
      paddingHorizontal: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 4,
      backgroundColor: theme.colors.surface2,
    } satisfies ViewStyle,
    close: {
      width: CLOSE_PAINTED,
      height: CLOSE_PAINTED,
      // Fixed-size control next to a flexible field: it keeps its box rather
      // than being squeezed to nothing when the row runs out of room.
      flexShrink: 0,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      borderRadius: 4,
    } satisfies ViewStyle,
    closeGlyph,
    // Press is a colour shift and nothing else: the plugin palette carries no
    // interaction token, so a background change is not available here.
    closeGlyphOn: { ...closeGlyph, color: theme.colors.foreground },
    searchInput: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
      fontSize: compact ? 10 : 12,
      padding: 0,
    } satisfies TextStyle,
  };
}

/** Heavier rule between turns (dsh turn separator parity). Plain object: web create takes named-style dicts only. */
function turnRuleStyles(theme: PluginTheme): ViewStyle {
  return {
    height: 2,
    backgroundColor: theme.colors.border,
    marginVertical: 4,
  };
}

function TurnHeaderRow(props: {
  turn: number;
  title: string;
  usage?: {
    input?: number;
    cacheRead?: number;
    cacheWrite?: number;
    output?: number;
    think?: number;
  };
  open: boolean;
  compact: boolean;
  theme: PluginTheme;
  onToggle: () => void;
}) {
  const { turn, title, usage, open, compact, theme, onToggle } = props;
  const styles = useMemo(() => turnHeaderStyles(theme), [theme]);
  const usageLabel =
    usage === undefined
      ? ""
      : ` token: In ${(usage.input ?? 0).toLocaleString("en-US")}${usage.cacheRead === undefined ? "" : `(${usage.cacheRead.toLocaleString("en-US")})`} / out ${(usage.output ?? 0).toLocaleString("en-US")}`;
  return (
    <Pressable accessibilityRole="button" onPress={onToggle} testID={`turn-header-${turn}`}>
      <View style={styles.header}>
        <Text style={styles.chevron}>{open ? "▾" : "▸"}</Text>
        <Text style={styles.title}>{title}</Text>
        {usageLabel === "" || compact ? null : <Text style={styles.usage}>{usageLabel}</Text>}
      </View>
    </Pressable>
  );
}

function turnHeaderStyles(theme: PluginTheme) {
  return StyleSheet.create({
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
      backgroundColor: theme.colors.surface1,
    },
    chevron: { color: theme.colors.foregroundMuted, fontSize: 12 },
    title: {
      color: theme.colors.foreground,
      fontSize: 12,
      fontWeight: "600",
    },
    usage: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontVariant: ["tabular-nums"],
    },
  });
}

// ---------------------------------------------------------------------------
// Expansion: turns -> lead records (headers, cells, turn rules)
// ---------------------------------------------------------------------------

interface RowHandlers {
  toggleTurn(turn: number): void;
  pressCell?: (cell: TrajectoryCellProps) => void;
}

/** One FlatList row: either chrome (header/rule) or a virtualized cell row. */
type ListRow =
  | { kind: "chrome"; key: string; height: number; record: LeadRecord }
  | { kind: "cellrow"; key: string; height: number; cells: TrajectoryCellProps[] };

/** One virtual row dispatched to its renderer; props are stable references. */
const VirtualLedgerRow = memo(function VirtualLedgerRow(props: {
  row: ListRow;
  compact: boolean;
  theme: PluginTheme;
  handlers: RowHandlers;
  textFor?: (cell: TrajectoryCellProps) => string | undefined;
}) {
  const { row, compact, theme, handlers, textFor } = props;
  // Bound per-record callbacks: Pressable.onPress passes the press event as
  // the first argument, so the turn identity must be bound here rather than in
  // the JSX (and hooks must be unconditional across row kinds).
  const chrome = row.kind === "chrome" ? row.record : null;
  const toggleTurn = useCallback(() => {
    if (chrome?.__kind === "turn-header") handlers.toggleTurn(chrome.turn);
  }, [chrome, handlers]);
  if (row.kind === "chrome") {
    const record = row.record;
    if (record.__kind === "turn-header") {
      return (
        <TurnHeaderRow
          turn={record.turn}
          title={record.title}
          usage={record.usage}
          open={record.open}
          compact={compact}
          theme={theme}
          onToggle={toggleTurn}
        />
      );
    }
    return <View style={turnRuleStyles(theme)} testID="turn-rule" />;
  }
  return (
    <View>
      {row.cells.map((cell) => (
        <TrajectoryCellRow
          resolvedText={textFor?.(cell)}
          key={cell.index}
          cell={cell}
          compact={compact}
          theme={theme}
          onPress={handlers.pressCell}
          testID={`cell-${cell.index}`}
        />
      ))}
    </View>
  );
});

type LeadRecord =
  | {
      __kind: "turn-header";
      turn: number;
      title: string;
      usage?: TrajectoryTurnModel["usage"];
      open: boolean;
    }
  | { __kind: "turn-rule"; turn: number }
  | { __kind: "cell"; cell: TrajectoryCellProps };

/**
 * Keep only the groups holding a match. Turn objects are kept even when they end
 * up empty, because turn numbers are positional — dropping a turn would renumber
 * every turn after it and the ledger would disagree with the recorder.
 */
function filterTurnsByMatch(
  turns: readonly TrajectoryTurnModel[],
  matches: ReadonlySet<string>,
): TrajectoryTurnModel[] {
  return turns.map((turn) => ({
    ...turn,
    groups: turn.groups
      .map((group) => ({
        ...group,
        cells: group.cells.filter((cell) => matches.has(trajectoryRecordId(cell))),
      }))
      .filter((group) => group.cells.length > 0),
  }));
}

function expandTurns(
  turns: readonly TrajectoryTurnModel[],
  fold: FoldState,
  hideEmptyTurns = false,
): LeadRecord[] {
  const records: LeadRecord[] = [];
  // Only buckets that carry a real turn number consume one. The unnumbered
  // preamble bucket (the system prompt, recorded with turn=null) is labelled
  // "Setup" and stays out of the count, so Turn 1 is still the first real turn
  // rather than being pushed down by a row that belongs to no turn.
  let numbered = 0;
  turns.forEach((turn) => {
    const isNumbered = turn.turn !== null;
    const turnNumber = isNumbered ? ++numbered : 0;
    const open = !fold.closedTurns.has(turnNumber);
    // Under an active search a turn with no match is noise; drop its header and
    // rule so results read as one list, while positional numbering is untouched.
    if (hideEmptyTurns && turn.groups.length === 0) return;
    if (records.length > 0) records.push({ __kind: "turn-rule", turn: turnNumber });
    records.push({
      __kind: "turn-header",
      turn: turnNumber,
      title: isNumbered ? `Turn ${turnNumber}` : "Setup",
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      open,
    });
    if (!open) return;
    // No step grouping in the UI: every cell sits directly under its turn
    // header, so the ledger reads as one table.
    for (const group of turn.groups) {
      for (const cell of group.cells) records.push(cellRecord(cell));
    }
  });
  return records;
}

function cellRecord(cell: TrajectoryCellProps): LeadRecord {
  return { __kind: "cell", cell };
}

/** Flat, readable row keys (RN keys must be strings without NUL). */
function chromeKey(record: LeadRecord): string {
  if (record.__kind === "turn-header") return `turn-${record.turn}`;
  if (record.__kind === "turn-rule") return `rule-${record.turn}`;
  // Cell records never reach here — they are filtered before chrome keys are
  // built — but the function stays total rather than reading `.turn` off a
  // variant that has none.
  return "cell";
}

function screenStyles(theme: PluginTheme): ViewStyle {
  return {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  };
}
