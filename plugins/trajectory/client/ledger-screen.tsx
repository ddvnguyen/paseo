import { memo, useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { deriveTrajectoryLayout } from "../shared/dsh/layout.js";
import type {
  TrajectoryFoldRow,
  TrajectoryGroupModel,
  TrajectoryTurnModel,
} from "../shared/dsh/layout.js";
import { groupTrajectoryVirtualRows } from "../shared/dsh/virtual-rows.js";
import type { TrajectoryCellProps } from "../shared/dsh/record.js";
import { TrajectoryCellRow } from "./ledger-cells.js";

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
  testID?: string;
}) {
  const { rows, turnNumbers, openCallIds, compact, theme, onCellPress, testID } = props;
  const [fold, setFold] = useState<FoldState>(INITIAL_FOLD);
  const [follow, setFollow] = useState(true);
  const listRef = useRef<FlatList<ListRow> | null>(null);

  const turns = useMemo(
    () => deriveTrajectoryLayout({ rows, turnNumbers, openCallIds }),
    [rows, turnNumbers, openCallIds],
  );

  const records = useMemo(() => expandTurns(turns, fold), [turns, fold]);

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

  const allOpen = useMemo(
    () => ({
      openTurns: new Set(turns.map((_, index) => index + 1)),
      openSteps: new Set(
        turns.flatMap((turn, index) =>
          turn.groups
            .filter((group) => group.title.startsWith("Step "))
            .map((group) => `step-${index + 1}-${group.title}`),
        ),
      ),
    }),
    [turns],
  );

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

  const foldAll = useCallback(() => setFold(INITIAL_FOLD), []);
  const unfoldAll = useCallback(() => setFold(allOpen), [allOpen]);

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
      <VirtualLedgerRow row={item} compact={compact} theme={theme} handlers={handlers} />
    ),
    [compact, theme, handlers],
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
      <Toolbar compact={compact} theme={theme} onFoldAll={foldAll} onUnfoldAll={unfoldAll} />
      <FlatList
        ref={listRef}
        data={virtualRows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
        initialNumToRender={24}
        testID="ledger-list"
      />
    </View>
  );
}

/** Toolbar: fold-all / unfold-all (dsh toolbar parity, RN form). */
function Toolbar(props: {
  compact: boolean;
  theme: PluginTheme;
  onFoldAll: () => void;
  onUnfoldAll: () => void;
}) {
  const { compact, theme, onFoldAll, onUnfoldAll } = props;
  const styles = useMemo(() => toolbarStyles(theme), [theme]);
  return (
    <View style={styles.bar} testID="ledger-toolbar">
      <Pressable accessibilityRole="button" onPress={onFoldAll} testID="fold-all">
        <Text style={styles.action}>fold all</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={onUnfoldAll} testID="unfold-all">
        <Text style={styles.action}>unfold all</Text>
      </Pressable>
      {compact ? null : <View style={styles.spacer} />}
    </View>
  );
}

function toolbarStyles(theme: PluginTheme) {
  return StyleSheet.create({
    bar: {
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    action: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
    },
    spacer: { flex: 1 },
  });
}

/** Heavier rule between turns (dsh turn separator parity). */
function turnRuleStyles(theme: PluginTheme) {
  return StyleSheet.create({
    height: 2,
    backgroundColor: theme.colors.border,
    marginVertical: 4,
  });
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
  open: boolean;
  compact: boolean;
  theme: PluginTheme;
  onToggle: () => void;
}) {
  const { title, open, theme, onToggle } = props;
  const styles = useMemo(() => stepHeaderStyles(theme), [theme]);
  return (
    <Pressable accessibilityRole="button" onPress={onToggle} testID={`step-header-${title}`}>
      <View style={styles.header}>
        <Text style={styles.chevron}>{open ? "▾" : "▸"}</Text>
        <Text style={styles.title}>{title}</Text>
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
}) {
  const { row, compact, theme, handlers } = props;
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
  | { __kind: "step-header"; turn: number; title: string; open: boolean }
  | { __kind: "turn-rule"; turn: number }
  | { __kind: "cell"; cell: TrajectoryCellProps };

/** Flatten folded turns into virtualizable records (headers + visible cells). */
function expandTurns(turns: readonly TrajectoryTurnModel[], fold: FoldState): LeadRecord[] {
  const records: LeadRecord[] = [];
  turns.forEach((turn, index) => {
    const turnNumber = index + 1;
    const open = fold.openTurns.has(turnNumber);
    const hasSteps = turn.groups.some((group) => group.title.startsWith("Step "));
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
  records.push({ __kind: "step-header", turn, title: group.title, open });
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
  return `rule-${record.turn}`;
}

function screenStyles(theme: PluginTheme) {
  return StyleSheet.create({
    flex: 1,
    backgroundColor: theme.colors.surface0,
  });
}
