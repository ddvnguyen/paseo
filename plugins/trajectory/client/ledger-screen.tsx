import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { deriveTrajectoryLayout } from "../shared/dsh/layout.js";
import type {
  TrajectoryFoldRow,
  TrajectoryGroupModel,
  TrajectoryTurnModel,
} from "../shared/dsh/layout.js";
import { groupTrajectoryVirtualRows } from "../shared/dsh/virtual-rows.js";
import { TrajectorySearchIndex } from "../shared/dsh/search-index.js";
import { trajectoryRecordId, type TrajectoryCellProps } from "../shared/dsh/record.js";
import { TrajectoryCellRow } from "./ledger-cells.js";
import { TrajectoryTimelineStrip } from "./trajectory-timeline.js";

/**
 * Trajectory ledger screen (T2.2): FlatList over the ported virtual-row
 * projection of the ported layout fold. Turn/step headers fold and unfold;
 * a heavier rule separates turns; tail-follow engages only when the list is
 * at the bottom. `compact` (phone) collapses kind tags to icons and tightens
 * paddings. Data comes from `rows` (fixtures in T2.2; trajectory.list/changes
 * via useRpc in T2.4).
 */

/**
 * Fold state is keyed by turn IDENTITY, never by position. Prepending older
 * history (S4) renumbers every turn, so a positional key would re-point an
 * open turn at whichever turn slid into its slot and close the one the user
 * actually opened.
 */
interface FoldState {
  /** Unfolded turn identities (default: all folded to headers). */
  openTurns: ReadonlySet<string>;
  /** Unfolded `<turnIdentity>:stepTitle` keys (default: open with their turn). */
  openSteps: ReadonlySet<string>;
}

/**
 * A turn carrying the stable identity every key and the fold state are keyed
 * by. Computed once, from the UNFILTERED fold: deriving it later would let a
 * search that empties a turn's first group silently change the turn's identity.
 */
interface KeyedTurn extends TrajectoryTurnModel {
  key: string;
}

/**
 * A turn's stable identity: the first cell's recordId, which is the same
 * content-derived identity cell rows already key on, and unique per cell, so
 * two turns can never share one.
 *
 * Not `turn.turn`: the fold buckets turns by their positional NUMBER, which
 * renumbers when older history is prepended. A turn's first cell is stable
 * under both ledger mutations — appends extend a turn at its tail, prepends
 * add whole older turns.
 */
function turnKeyOf(turn: TrajectoryTurnModel): string {
  for (const group of turn.groups) {
    const first = group.cells[0];
    if (first !== undefined) return `c:${trajectoryRecordId(first)}`;
  }
  return `c:empty-${turn.turn}`;
}

/** Fold key for a step group inside a turn. */
function stepIdentity(turnKey: string, title: string): string {
  return `${turnKey}:${title}`;
}

const INITIAL_FOLD: FoldState = { openTurns: new Set(), openSteps: new Set() };

/**
 * How close to the end counts as "at the bottom" when deciding follow.
 *
 * dsh uses 2px. This is deliberately more forgiving: at 2px a one-pixel
 * overscroll disengages follow, and on a live ledger that means the view
 * silently stops advancing while new events pile up unseen. Revisit with S3,
 * once there is a virtualizer to anchor against.
 */
const BOTTOM_FOLLOW_THRESHOLD_PX = 24;

/**
 * Measured row heights, in CSS px, for the chrome rows this screen renders.
 *
 * These were guesses until they were measured. getItemLayout is only safe on
 * numbers the rows actually occupy: a wrong constant does not read as a config
 * mistake, it reads as a scroll bug, which is worse than having no
 * getItemLayout at all.
 *
 * Measured in Chromium 149 against the real react-native-web tree, on the
 * item wrappers VirtualizedList positions (not the inner elements), at 1280px
 * and 390px, compact and not, with short and 190-character labels. Identical
 * in all six configurations: the rows are fixed-height or single-line clamped,
 * so width and compact do not move them. Reproduce with
 * `node scripts/measure-row-heights.mjs` in this directory.
 */
const TURN_HEADER_HEIGHT = 22;
const STEP_HEADER_HEIGHT = 17;
const TURN_RULE_HEIGHT = 10;

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
  /** False once the ledger's older history is exhausted; hides the control. */
  hasOlderHistory?: boolean;
  /** A load-older read is in flight; the control disables and says so. */
  loadingOlder?: boolean;
  /** Request the next older page. */
  onLoadOlder?: () => void;
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
    hasOlderHistory = false,
    loadingOlder = false,
    onLoadOlder,
    testID,
  } = props;
  const [fold, setFold] = useState<FoldState>(INITIAL_FOLD);
  const followRef = useRef(true);
  /** Latest scroll offset, so the anchor can be captured before a prepend. */
  const scrollOffsetRef = useRef(0);
  /**
   * The row to hold still across a prepend, and the offset it was at. Set when
   * load-older is requested, consumed once the projection has moved.
   */
  const anchorRef = useRef<{ key: string; offset: number } | null>(null);
  const [query, setQuery] = useState("");
  const [actualDuration, setActualDuration] = useState(false);
  const listRef = useRef<FlatList<ListRow> | null>(null);

  const turns = useMemo(
    () => deriveTrajectoryLayout({ rows, turnNumbers, openCallIds }),
    [rows, turnNumbers, openCallIds],
  );

  // Identity is stamped on once, here, while the fold is still unfiltered.
  const keyedTurns = useMemo<KeyedTurn[]>(
    () => turns.map((turn) => ({ ...turn, key: turnKeyOf(turn) })),
    [turns],
  );

  // Everything open, as a fold state. Shared by the "unfold all" action and by an
  // active search, which must not leave a match stranded behind a collapsed header.
  const allOpen = useMemo<FoldState>(
    () => ({
      openTurns: new Set(turnKeys(keyedTurns)),
      openSteps: new Set(allStepKeys(keyedTurns)),
    }),
    [keyedTurns],
  );

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

  // A match inside a collapsed turn or step would be unreachable, so an active
  // search forces the fold open rather than hiding results behind a header.
  const effectiveFold = matches === null ? fold : allOpen;
  // filterTurnsByMatch spreads each turn, so the stamped key survives filtering.
  const visibleTurns = useMemo(
    () => (matches === null ? keyedTurns : filterTurnsByMatch(keyedTurns, matches)),
    [keyedTurns, matches],
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
  /**
   * The previous projection, reused when the rebuild changed no key and no
   * height. A text-only delta (resolved cell text, a label edit) produces a
   * new fold and new cell objects, so a plain useMemo hands the list a new
   * array every time — which invalidates the identity getItemLayout and the
   * measurement cache behind it depend on, for rows that are laid out exactly
   * as before.
   */
  const virtualRowsRef = useRef<ListRow[] | null>(null);
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
        let height = TURN_RULE_HEIGHT;
        if (record.__kind === "turn-header") height = TURN_HEADER_HEIGHT;
        else if (record.__kind === "step-header") height = STEP_HEADER_HEIGHT;
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
    const previous = virtualRowsRef.current;
    if (previous !== null && sameShape(previous, out)) return previous;
    virtualRowsRef.current = out;
    return out;
  }, [records]);

  const toggleTurn = useCallback((turnKey: string) => {
    setFold((previous) => {
      const openTurns = new Set(previous.openTurns);
      const openSteps = new Set(previous.openSteps);
      if (openTurns.has(turnKey)) {
        openTurns.delete(turnKey);
        const prefix = `${turnKey}:`;
        for (const key of openSteps) {
          if (key.startsWith(prefix)) openSteps.delete(key);
        }
      } else {
        openTurns.add(turnKey);
      }
      return { openTurns, openSteps };
    });
  }, []);

  const toggleStep = useCallback((turnKey: string, title: string) => {
    setFold((previous) => {
      const openSteps = new Set(previous.openSteps);
      const key = stepIdentity(turnKey, title);
      if (openSteps.has(key)) openSteps.delete(key);
      else openSteps.add(key);
      return { ...previous, openSteps };
    });
  }, []);

  // Toolbar toggles are tri-state-free on purpose: each one is either "everything
  // open" or "everything closed", matching the dsh aria-pressed contract. A mixed
  // state reports closed, so a press always moves toward fully open.
  const allTurnsOpen = turnKeys(keyedTurns).every((turn) => fold.openTurns.has(turn));
  const stepKeys = useMemo(() => allStepKeys(keyedTurns), [keyedTurns]);
  const allStepsOpen = stepKeys.length > 0 && stepKeys.every((key) => fold.openSteps.has(key));

  const toggleAllTurns = useCallback(() => {
    setFold((previous) => {
      const openTurns = new Set(previous.openTurns);
      if (turnKeys(keyedTurns).every((turn) => openTurns.has(turn))) {
        return INITIAL_FOLD;
      }
      return {
        openTurns: new Set(turnKeys(keyedTurns)),
        openSteps: new Set([...previous.openSteps, ...stepKeys]),
      };
    });
  }, [keyedTurns, stepKeys]);

  const toggleAllSteps = useCallback(() => {
    setFold((previous) => {
      const openSteps = new Set(previous.openSteps);
      const everyStepOpen = stepKeys.length > 0 && stepKeys.every((key) => openSteps.has(key));
      if (everyStepOpen) {
        return { ...previous, openSteps: new Set() };
      }
      // Opening a step whose turn is shut would be invisible, so open the turns too.
      return {
        openTurns: new Set([...previous.openTurns, ...turnKeys(keyedTurns)]),
        openSteps: new Set([...openSteps, ...stepKeys]),
      };
    });
  }, [keyedTurns, stepKeys]);

  const onQueryChange = useCallback((value: string) => setQuery(value), []);
  const onToggleDuration = useCallback(() => setActualDuration((value) => !value), []);

  const handlers = useMemo(
    () => ({
      toggleTurn,
      toggleStep,
      pressCell:
        onCellPress === undefined
          ? undefined
          : (cell: TrajectoryCellProps) => {
              onCellPress(cell);
            },
    }),
    [toggleTurn, toggleStep, onCellPress],
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

  /**
   * Prefix sums of the row heights, so getItemLayout is O(1) instead of
   * re-walking the list for every item in the window. `offsets[n]` is the total
   * content height, which is what a windowed list needs to size its scrollbar
   * without laying every row out.
   */
  const rowOffsets = useMemo(() => {
    const offsets: number[] = [];
    let total = 0;
    for (const [index, row] of virtualRows.entries()) {
      offsets[index] = total;
      total += row.height;
    }
    offsets[virtualRows.length] = total;
    return offsets;
  }, [virtualRows]);

  /**
   * Row geometry, on measured heights (see TURN_HEADER_HEIGHT). Without it a
   * windowed list has to measure rows as it scrolls; with it, a wrong constant
   * shows up immediately as a misaligned scroll, so the numbers above are the
   * measured ones and the fallback is only reached if the index is out of
   * range.
   */
  const getItemLayout = useCallback(
    (_data: ArrayLike<ListRow> | null | undefined, index: number) => ({
      length: virtualRows[index]?.height ?? TURN_RULE_HEIGHT,
      offset: rowOffsets[index] ?? 0,
      index,
    }),
    [rowOffsets, virtualRows],
  );

  const onContentSizeChange = useCallback(() => {
    if (followRef.current && listRef.current !== null) {
      listRef.current.scrollToEnd({ animated: false });
    }
  }, []);

  const onScroll = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: { y: number };
        contentSize?: { height: number };
        layoutMeasurement: { height: number };
      };
    }) => {
      const { y } = event.nativeEvent.contentOffset;
      scrollOffsetRef.current = y;
      const contentHeight = event.nativeEvent.contentSize?.height;
      // An event with no content measurement cannot say where the list is.
      // Reading it as "at the bottom" would re-arm follow on any partial
      // event, and the next append would then yank a scrolled-up view back to
      // the tail. An unmeasurable event is not evidence either way, so it
      // leaves follow alone.
      if (contentHeight === undefined) return;
      const viewport = event.nativeEvent.layoutMeasurement.height;
      const atBottom = y + viewport >= contentHeight - BOTTOM_FOLLOW_THRESHOLD_PX;
      // Ref, not state: follow is read in exactly one place and never rendered,
      // so a state flip here would re-render the whole screen mid-scroll for
      // a value nothing on screen depends on.
      followRef.current = atBottom;
    },
    [],
  );

  /**
   * Hold the viewport still across a prepend. getItemLayout is prefix-summed,
   * so every row below the new page shifts down by the height of what was
   * inserted; without this the content the user was reading jumps by exactly
   * that much. The anchor is a row KEY (stable since the turn-identity work),
   * not an index, so it survives the renumbering.
   *
   * Runtime note: maintainVisibleContentPosition does this natively on RN but
   * is absent from react-native-web's VirtualizedList, so it is done here
   * imperatively, which works on both.
   */
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (anchor === null) return;
    const index = virtualRows.findIndex((row) => row.key === anchor.key);
    if (index < 0) return;
    const shift = rowOffsets[index] ?? 0;
    // Nothing shifted yet (the projection has not actually moved), so leave
    // the anchor armed rather than scrolling by zero and giving up.
    if (shift === 0) return;
    anchorRef.current = null;
    listRef.current?.scrollToOffset({ offset: anchor.offset + shift, animated: false });
  }, [virtualRows, rowOffsets]);

  const loadOlder = useCallback(() => {
    if (loadingOlder || onLoadOlder === undefined) return;
    const first = virtualRows[0];
    if (first === undefined) return;
    anchorRef.current = { key: first.key, offset: scrollOffsetRef.current };
    onLoadOlder();
  }, [loadingOlder, onLoadOlder, virtualRows]);

  return (
    <View style={screenStyles(theme)} testID={testID ?? "ledger-screen"}>
      <Toolbar
        compact={compact}
        theme={theme}
        actualDuration={actualDuration}
        allTurnsOpen={allTurnsOpen}
        allStepsOpen={allStepsOpen}
        query={query}
        onToggleDuration={onToggleDuration}
        onToggleTurns={toggleAllTurns}
        onToggleCalls={toggleAllSteps}
        onQueryChange={onQueryChange}
      />
      <TrajectoryTimelineStrip
        turns={visibleTurns}
        actualDuration={actualDuration}
        compact={compact}
        theme={theme}
      />
      {hasOlderHistory && onLoadOlder !== undefined ? (
        <Pressable
          accessibilityRole="button"
          onPress={loadOlder}
          disabled={loadingOlder}
          testID="load-older"
          style={loadOlderStyles(theme, loadingOlder)}
        >
          <Text style={loadOlderTextStyles(theme)} testID="load-older-label">
            {loadingOlder ? "Loading older events…" : "Load older events"}
          </Text>
        </Pressable>
      ) : null}
      <FlatList
        ref={listRef}
        data={virtualRows}
        keyExtractor={keyExtractor}
        getItemLayout={getItemLayout}
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
 * dsh-parity toolbar: Duration / Turns / Calls toggles plus a search box.
 * Look follows TrajectoryToolbar.module.css — 20px chips, 3px radius, transparent
 * until pressed — mapped onto plugin theme tokens.
 *
 * Plain objects, not StyleSheet.create: these carry theme colors, and the
 * themed-factory form re-registers styles on every theme (the c05e19c24
 * react-native-web WeakMap hazard).
 */
function Toolbar(props: {
  compact: boolean;
  theme: PluginTheme;
  actualDuration: boolean;
  allTurnsOpen: boolean;
  allStepsOpen: boolean;
  query: string;
  onToggleDuration: () => void;
  onToggleTurns: () => void;
  onToggleCalls: () => void;
  onQueryChange: (value: string) => void;
}) {
  const {
    compact,
    theme,
    actualDuration,
    allTurnsOpen,
    allStepsOpen,
    query,
    onToggleDuration,
    onToggleTurns,
    onToggleCalls,
    onQueryChange,
  } = props;
  const styles = useMemo(() => toolbarStyles(theme, compact), [theme, compact]);
  return (
    <View style={styles.bar} testID="ledger-toolbar">
      <View style={styles.actions}>
        <ToolbarToggle
          label="Duration"
          icon="◷"
          pressed={actualDuration}
          onPress={onToggleDuration}
          styles={styles}
          testID="toggle-duration"
        />
        <ToolbarToggle
          label="Turns"
          icon={allTurnsOpen ? "⊟" : "⊞"}
          pressed={!allTurnsOpen}
          onPress={onToggleTurns}
          styles={styles}
          testID="toggle-turns"
        />
        <ToolbarToggle
          label="Calls"
          icon={allStepsOpen ? "⊟" : "⊞"}
          pressed={!allStepsOpen}
          onPress={onToggleCalls}
          styles={styles}
          testID="toggle-calls"
        />
      </View>
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
    </View>
  );
}

function ToolbarToggle(props: {
  label: string;
  icon: string;
  pressed: boolean;
  onPress: () => void;
  styles: ReturnType<typeof toolbarStyles>;
  testID: string;
}) {
  const { label, icon, pressed, onPress, styles, testID } = props;
  // Memoised so a re-render does not hand Pressable/Text fresh style arrays.
  const resolved = useMemo(
    () => ({
      a11yState: { selected: pressed },
      pressable: pressed ? [styles.toggle, styles.toggleOn] : styles.toggle,
      icon: pressed ? [styles.toggleIcon, styles.toggleOnText] : styles.toggleIcon,
      label: pressed ? [styles.toggleLabel, styles.toggleOnText] : styles.toggleLabel,
    }),
    [pressed, styles],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={resolved.a11yState}
      accessibilityLabel={label}
      onPress={onPress}
      style={resolved.pressable}
      testID={testID}
    >
      <Text style={resolved.icon}>{icon}</Text>
      <Text style={resolved.label}>{label}</Text>
    </Pressable>
  );
}

function toolbarStyles(theme: PluginTheme, compact: boolean) {
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
    actions: { flexDirection: "row", alignItems: "center", gap: 2 } satisfies ViewStyle,
    toggle: {
      flexDirection: "row",
      alignItems: "center",
      height: 20,
      paddingHorizontal: 7,
      gap: 4,
      borderRadius: 3,
    } satisfies ViewStyle,
    toggleOn: { backgroundColor: theme.colors.surface2 } satisfies ViewStyle,
    toggleIcon: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 10 : 12,
    } satisfies TextStyle,
    toggleLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 10 : 12,
    } satisfies TextStyle,
    toggleOnText: { color: theme.colors.foreground } satisfies TextStyle,
    search: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      height: 22,
      marginLeft: 8,
      paddingHorizontal: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 4,
      backgroundColor: theme.colors.surface2,
    } satisfies ViewStyle,
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
  hasSteps: boolean;
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

function StepHeaderRow(props: {
  turn: number;
  title: string;
  description?: string;
  open: boolean;
  compact: boolean;
  theme: PluginTheme;
  onToggle: () => void;
}) {
  const { title, description, open, theme, onToggle } = props;
  const styles = useMemo(() => stepHeaderStyles(theme), [theme]);
  return (
    <Pressable accessibilityRole="button" onPress={onToggle} testID={`step-header-${title}`}>
      <View style={styles.header}>
        <Text style={styles.chevron}>{open ? "▾" : "▸"}</Text>
        <Text style={styles.title}>{title}</Text>
        {description === undefined ? null : (
          <Text style={styles.description} numberOfLines={1} testID="group-description">
            {description}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function stepHeaderStyles(theme: PluginTheme) {
  return StyleSheet.create({
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingLeft: 16,
      paddingVertical: 2,
    },
    chevron: { color: theme.colors.foregroundMuted, fontSize: 11 },
    title: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "600",
    },
    description: {
      // The fold's wall span + tool histogram: supporting detail, so it is
      // muted and clipped rather than styled as a second title. C2b pairing —
      // flexShrink alone would not truncate this on web.
      flexShrink: 1,
      minWidth: 0,
      color: theme.colors.foregroundMuted,
      fontSize: 10,
    } satisfies TextStyle,
  });
}

// ---------------------------------------------------------------------------
// Expansion: turns -> lead records (headers, cells, turn rules)
// ---------------------------------------------------------------------------

interface RowHandlers {
  toggleTurn(turnKey: string): void;
  toggleStep(turnKey: string, title: string): void;
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
  // the first argument, so the turn/step identity must be bound here rather
  // than in the JSX (and hooks must be unconditional across row kinds).
  const chrome = row.kind === "chrome" ? row.record : null;
  const toggleTurn = useCallback(() => {
    if (chrome?.__kind === "turn-header") handlers.toggleTurn(chrome.turnKey);
  }, [chrome, handlers]);
  const toggleStep = useCallback(() => {
    if (chrome?.__kind === "step-header") handlers.toggleStep(chrome.turnKey, chrome.title);
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
          hasSteps={record.hasSteps}
          compact={compact}
          theme={theme}
          onToggle={toggleTurn}
        />
      );
    }
    if (record.__kind === "step-header") {
      return (
        <StepHeaderRow
          turn={record.turn}
          title={record.title}
          description={record.description}
          open={record.open}
          compact={compact}
          theme={theme}
          onToggle={toggleStep}
        />
      );
    }
    return <View style={turnRuleStyles(theme)} testID="turn-rule" />;
  }
  return (
    <View testID={`listrow-${row.key}`}>
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
      turnKey: string;
      title: string;
      usage?: TrajectoryTurnModel["usage"];
      open: boolean;
      hasSteps: boolean;
    }
  | {
      __kind: "step-header";
      turn: number;
      turnKey: string;
      title: string;
      description?: string;
      open: boolean;
    }
  | { __kind: "turn-rule"; turn: number; turnKey: string }
  | { __kind: "cell"; cell: TrajectoryCellProps };

/** True when two projections agree on every row's key and height. */
function sameShape(a: readonly ListRow[], b: readonly ListRow[]): boolean {
  if (a.length !== b.length) return false;
  for (const [index, row] of b.entries()) {
    const previous = a[index];
    if (previous === undefined) return false;
    if (previous.key !== row.key || previous.height !== row.height) return false;
  }
  return true;
}

/** Flatten folded turns into virtualizable records (headers + visible cells). */
/** Turn numbers are positional (1..N) throughout the fold, as expandTurns uses. */
/** Every turn's stable identity, in display order. */
function turnKeys(turns: readonly KeyedTurn[]): string[] {
  return turns.map((turn) => turn.key);
}

/** `<turnIdentity>:stepTitle` keys for every Step group, matching expandTurns. */
function allStepKeys(turns: readonly KeyedTurn[]): string[] {
  return turns.flatMap((turn) =>
    turn.groups
      .filter((group) => group.title.startsWith("Step "))
      .map((group) => stepIdentity(turn.key, group.title)),
  );
}

/**
 * Keep only the groups holding a match. Turn objects are kept even when they end
 * up empty, because turn numbers are positional — dropping a turn would renumber
 * every turn after it and the ledger would disagree with the recorder.
 */
function filterTurnsByMatch(
  turns: readonly KeyedTurn[],
  matches: ReadonlySet<string>,
): KeyedTurn[] {
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
  turns: readonly KeyedTurn[],
  fold: FoldState,
  hideEmptyTurns = false,
): LeadRecord[] {
  const records: LeadRecord[] = [];
  turns.forEach((turn, index) => {
    const turnNumber = index + 1;
    const turnKey = turn.key;
    const open = fold.openTurns.has(turnKey);
    const hasSteps = turn.groups.some((group) => group.title.startsWith("Step "));
    // Under an active search a turn with no match is noise; drop its header and
    // rule so results read as one list, while positional numbering is untouched.
    if (hideEmptyTurns && turn.groups.length === 0) return;
    if (index > 0) records.push({ __kind: "turn-rule", turn: turnNumber, turnKey });
    records.push({
      __kind: "turn-header",
      turn: turnNumber,
      turnKey,
      title: `Turn ${turnNumber}`,
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      open,
      hasSteps,
    });
    if (!open) return;
    for (const group of turn.groups) {
      appendGroup(records, turnNumber, turnKey, group, fold);
    }
  });
  return records;
}

function appendGroup(
  records: LeadRecord[],
  turn: number,
  turnKey: string,
  group: TrajectoryGroupModel,
  fold: FoldState,
): void {
  if (group.title === "Message") {
    for (const cell of group.cells) records.push(cellRecord(cell));
    return;
  }
  const open = fold.openSteps.has(stepIdentity(turnKey, group.title));
  // The fold already computed the wall span + tool histogram for this group;
  // it was simply never rendered.
  records.push({
    __kind: "step-header",
    turn,
    turnKey,
    title: group.title,
    ...(group.description === undefined ? {} : { description: group.description }),
    open,
  });
  if (open) {
    for (const cell of group.cells) records.push(cellRecord(cell));
  }
}

function cellRecord(cell: TrajectoryCellProps): LeadRecord {
  return { __kind: "cell", cell };
}

/**
 * Row keys, derived from turn IDENTITY rather than position: a windowed list
 * keys on identity, and prepending older history (S4) renumbers every turn. A
 * positional key would remount every chrome row and hand React a different
 * turn's row under the same key. Cell rows already use recordId, which is
 * content-derived. RN keys must be strings without NUL.
 */
function chromeKey(record: LeadRecord): string {
  if (record.__kind === "turn-header") return `turn-${record.turnKey}`;
  if (record.__kind === "step-header") return `step-${record.turnKey}-${record.title}`;
  if (record.__kind === "turn-rule") return `rule-${record.turnKey}`;
  // Cell records never reach here — they are filtered before chrome keys are
  // built — but the function stays total rather than reading `.turn` off a
  // variant that has none.
  return "cell";
}

/** The load-older control: a real control, not a scroll threshold. dsh shipped a
 *  48px threshold first and only added an interactive row 9 days later, because
 *  a threshold is not discoverable and fails silently. It sits above the list
 *  rather than inside it, so it needs no row height (and no getItemLayout
 *  entry) and stays reachable while the user watches the tail. */
function loadOlderStyles(theme: PluginTheme, loading: boolean): ViewStyle {
  return {
    paddingVertical: 8,
    paddingHorizontal: 6,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    opacity: loading ? 0.6 : 1,
  };
}

function loadOlderTextStyles(theme: PluginTheme): TextStyle {
  return {
    fontSize: 12,
    color: theme.colors.accent,
    fontWeight: "600",
  };
}

function screenStyles(theme: PluginTheme): ViewStyle {
  return {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  };
}
