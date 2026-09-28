import { memo, useCallback, useMemo, useRef, useState } from "react";
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

interface FoldState {
  /** Unfolded turn numbers (default: all folded to headers). */
  openTurns: ReadonlySet<number>;
  /** Unfolded `turnNumber:stepTitle` keys (default: open with their turn). */
  openSteps: ReadonlySet<string>;
}

const INITIAL_FOLD: FoldState = { openTurns: new Set(), openSteps: new Set() };

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
    testID,
  } = props;
  const [fold, setFold] = useState<FoldState>(INITIAL_FOLD);
  const [follow, setFollow] = useState(true);
  const [query, setQuery] = useState("");
  const [actualDuration, setActualDuration] = useState(false);
  const listRef = useRef<FlatList<ListRow> | null>(null);

  const turns = useMemo(
    () => deriveTrajectoryLayout({ rows, turnNumbers, openCallIds }),
    [rows, turnNumbers, openCallIds],
  );

  // Everything open, as a fold state. Shared by the "unfold all" action and by an
  // active search, which must not leave a match stranded behind a collapsed header.
  const allOpen = useMemo<FoldState>(
    () => ({ openTurns: new Set(turnNumbers1ToN(turns)), openSteps: new Set(allStepKeys(turns)) }),
    [turns],
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
        let height = 10;
        if (record.__kind === "turn-header") height = 28;
        else if (record.__kind === "step-header") height = 22;
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
      const openTurns = new Set(previous.openTurns);
      const openSteps = new Set(previous.openSteps);
      if (openTurns.has(turn)) {
        openTurns.delete(turn);
        const prefix = `step-${turn}-`;
        for (const key of openSteps) {
          if (key.startsWith(prefix)) openSteps.delete(key);
        }
      } else {
        openTurns.add(turn);
      }
      return { openTurns, openSteps };
    });
  }, []);

  const toggleStep = useCallback((turn: number, title: string) => {
    setFold((previous) => {
      const openSteps = new Set(previous.openSteps);
      const key = `step-${turn}-${title}`;
      if (openSteps.has(key)) openSteps.delete(key);
      else openSteps.add(key);
      return { ...previous, openSteps };
    });
  }, []);

  // Toolbar toggles are tri-state-free on purpose: each one is either "everything
  // open" or "everything closed", matching the dsh aria-pressed contract. A mixed
  // state reports closed, so a press always moves toward fully open.
  const allTurnsOpen = turnNumbers1ToN(turns).every((turn) => fold.openTurns.has(turn));
  const stepKeys = useMemo(() => allStepKeys(turns), [turns]);
  const allStepsOpen = stepKeys.length > 0 && stepKeys.every((key) => fold.openSteps.has(key));

  const toggleAllTurns = useCallback(() => {
    setFold((previous) => {
      const openTurns = new Set(previous.openTurns);
      if (turnNumbers1ToN(turns).every((turn) => openTurns.has(turn))) {
        return INITIAL_FOLD;
      }
      return {
        openTurns: new Set(turnNumbers1ToN(turns)),
        openSteps: new Set([...previous.openSteps, ...stepKeys]),
      };
    });
  }, [turns, stepKeys]);

  const toggleAllSteps = useCallback(() => {
    setFold((previous) => {
      const openSteps = new Set(previous.openSteps);
      const everyStepOpen = stepKeys.length > 0 && stepKeys.every((key) => openSteps.has(key));
      if (everyStepOpen) {
        return { ...previous, openSteps: new Set() };
      }
      // Opening a step whose turn is shut would be invisible, so open the turns too.
      return {
        openTurns: new Set([...previous.openTurns, ...turnNumbers1ToN(turns)]),
        openSteps: new Set([...openSteps, ...stepKeys]),
      };
    });
  }, [turns, stepKeys]);

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
  toggleTurn(turn: number): void;
  toggleStep(turn: number, title: string): void;
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
    if (chrome?.__kind === "turn-header") handlers.toggleTurn(chrome.turn);
  }, [chrome, handlers]);
  const toggleStep = useCallback(() => {
    if (chrome?.__kind === "step-header") handlers.toggleStep(chrome.turn, chrome.title);
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
      hasSteps: boolean;
    }
  | { __kind: "step-header"; turn: number; title: string; description?: string; open: boolean }
  | { __kind: "turn-rule"; turn: number }
  | { __kind: "cell"; cell: TrajectoryCellProps };

/** Flatten folded turns into virtualizable records (headers + visible cells). */
/** Turn numbers are positional (1..N) throughout the fold, as expandTurns uses. */
function turnNumbers1ToN(turns: readonly TrajectoryTurnModel[]): number[] {
  return turns.map((_, index) => index + 1);
}

/** `turnNumber:stepTitle` keys for every Step group, matching expandTurns. */
function allStepKeys(turns: readonly TrajectoryTurnModel[]): string[] {
  return turns.flatMap((turn, index) =>
    turn.groups
      .filter((group) => group.title.startsWith("Step "))
      .map((group) => `step-${index + 1}-${group.title}`),
  );
}

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
  turns.forEach((turn, index) => {
    const turnNumber = index + 1;
    const open = fold.openTurns.has(turnNumber);
    const hasSteps = turn.groups.some((group) => group.title.startsWith("Step "));
    // Under an active search a turn with no match is noise; drop its header and
    // rule so results read as one list, while positional numbering is untouched.
    if (hideEmptyTurns && turn.groups.length === 0) return;
    if (index > 0) records.push({ __kind: "turn-rule", turn: turnNumber });
    records.push({
      __kind: "turn-header",
      turn: turnNumber,
      title: `Turn ${turnNumber}`,
      ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      open,
      hasSteps,
    });
    if (!open) return;
    for (const group of turn.groups) {
      appendGroup(records, turnNumber, group, fold);
    }
  });
  return records;
}

function appendGroup(
  records: LeadRecord[],
  turn: number,
  group: TrajectoryGroupModel,
  fold: FoldState,
): void {
  if (group.title === "Message") {
    for (const cell of group.cells) records.push(cellRecord(cell));
    return;
  }
  const key = `step-${turn}-${group.title}`;
  const open = fold.openSteps.has(key);
  // The fold already computed the wall span + tool histogram for this group;
  // it was simply never rendered.
  records.push({
    __kind: "step-header",
    turn,
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

/** Flat, readable row keys (RN keys must be strings without NUL). */
function chromeKey(record: LeadRecord): string {
  if (record.__kind === "turn-header") return `turn-${record.turn}`;
  if (record.__kind === "step-header") return `step-${record.turn}-${record.title}`;
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
