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
import type { TrajectoryVirtualRow } from "../shared/dsh/virtual-rows.js";
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
  const listRef = useRef<FlatList<TrajectoryVirtualRow<LeadRecord>> | null>(null);

  const turns = useMemo(
    () => deriveTrajectoryLayout({ rows, turnNumbers, openCallIds }),
    [rows, turnNumbers, openCallIds],
  );

  const records = useMemo(() => expandTurns(turns, fold), [turns, fold]);

  const virtualRows = useMemo(() => groupTrajectoryVirtualRows(records), [records]);

  const allOpen = useMemo(
    () => ({
      openTurns: new Set(turns.map((_, index) => index + 1)),
      openSteps: new Set(
        turns.flatMap((turn, index) =>
          turn.groups
            .filter((group) => group.title.startsWith("Step "))
            .map((group) => `${index + 1}\u0000${group.title}`),
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
        const prefix = `${turn}\u0000`;
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
      const key = `${turn}\u0000${title}`;
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
    ({ item }: { item: TrajectoryVirtualRow<LeadRecord> }) => (
      <VirtualLedgerRow row={item} compact={compact} theme={theme} handlers={handlers} />
    ),
    [compact, theme, handlers],
  );

  const keyExtractor = useCallback((item: TrajectoryVirtualRow<LeadRecord>) => item.key, []);

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

/** One virtual row dispatched to its renderer; props are stable references. */
const VirtualLedgerRow = memo(function VirtualLedgerRow(props: {
  row: TrajectoryVirtualRow<LeadRecord>;
  compact: boolean;
  theme: PluginTheme;
  handlers: RowHandlers;
}) {
  const { row, compact, theme, handlers } = props;
  const record = row.entries[0]?.record;
  if (record === undefined) return null;
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
        onToggle={handlers.toggleTurn}
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
        onToggle={handlers.toggleStep}
      />
    );
  }
  if (record.__kind === "turn-rule") {
    return <View style={turnRuleStyles(theme)} testID="turn-rule" />;
  }
  return (
    <TrajectoryCellRow
      cell={record.cell}
      compact={compact}
      theme={theme}
      onPress={handlers.pressCell}
      testID={`cell-${record.cell.index}`}
    />
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
  const key = `${turn}\u0000${group.title}`;
  const open = fold.openSteps.has(key);
  records.push({ __kind: "step-header", turn, title: group.title, open });
  if (open) {
    for (const cell of group.cells) records.push(cellRecord(cell));
  }
}

function cellRecord(cell: TrajectoryCellProps): LeadRecord {
  return { __kind: "cell", cell };
}

function screenStyles(theme: PluginTheme) {
  return StyleSheet.create({
    flex: 1,
    backgroundColor: theme.colors.surface0,
  });
}
