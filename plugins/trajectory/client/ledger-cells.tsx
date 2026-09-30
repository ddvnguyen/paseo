import { useCallback, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { TextStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { formatElapsedSeconds } from "../shared/dsh/record.js";
import type { TrajectoryCellProps } from "../shared/dsh/record.js";

/**
 * Ledger row primitives, laid out as a virtual table (T3-B).
 *
 * RN Views, never an HTML <table>: every row is the same four fixed columns —
 * TIME | TYPE | CONTEXT | STATS — so the columns line up down the list and a
 * reader can scan a column without re-reading each row. The column widths live
 * in `columnLayout` and are shared by the header and the rows, which is the only
 * thing keeping the header aligned with the body.
 *
 * CONTEXT is the one flexible column; TIME, TYPE and STATS are fixed so a long
 * tool argument can never shift the numbers sideways.
 */

/**
 * Column widths, shared by `LedgerColumnHeader` and every row.
 *
 * TIME fits `HH:MM:SS` plus a little slack. TYPE fits the widest kind tag.
 * STATS fits `token: In 1,234(56) / out 789`. CONTEXT takes the remainder.
 */
export function columnLayout(compact: boolean): {
  time: number;
  type: number;
  stats: number;
  gap: number;
  padLeft: number;
} {
  return compact
    ? { time: 52, type: 58, stats: 84, gap: 4, padLeft: 4 }
    : { time: 64, type: 68, stats: 150, gap: 8, padLeft: 6 };
}

/** Per-kind accent, mapped onto existing theme tokens. No new colors. */
export function kindAccentColor(
  theme: PluginTheme,
  kind: TrajectoryCellProps["kind"],
  isError: boolean,
): string {
  if (isError) return theme.colors.statusDanger;
  if (kind === "user") return theme.colors.statusSuccess;
  if (kind === "message" || kind === "compacted") return theme.colors.accent;
  if (kind === "tool" || kind === "subtool") return theme.colors.statusWarning;
  if (kind === "context") return theme.colors.statusSuccess;
  // system and anything unknown read as muted.
  return theme.colors.foregroundMuted;
}

/** Kept as the exported name the timeline strip and tests already use. */
export function kindRailColor(
  theme: PluginTheme,
  kind: TrajectoryCellProps["kind"],
  isError: boolean,
): string {
  return kindAccentColor(theme, kind, isError);
}

/** One-character stand-in per kind for compact layouts (no icon set import). */
const KIND_ICON: Record<TrajectoryCellProps["kind"], string> = {
  system: "S",
  user: "U",
  context: "C",
  compacted: "⤺",
  message: "M",
  tool: "T",
  subtool: "↳",
};

export function KindTag(props: {
  kind: TrajectoryCellProps["kind"];
  compact: boolean;
  theme: PluginTheme;
  error?: boolean;
}) {
  const { kind, compact, theme, error } = props;
  const isError = error === true;
  const accent = kindAccentColor(theme, kind, isError);
  const styles = useMemo(() => tagStyles(theme, accent, isError), [theme, accent, isError]);
  return (
    <View style={styles.tag} testID={`kind-tag-${kind}`}>
      <Text style={styles.tagText} numberOfLines={1}>
        {compact ? KIND_ICON[kind] : kind}
      </Text>
    </View>
  );
}

function tagStyles(theme: PluginTheme, accent: string, _error: boolean) {
  return StyleSheet.create({
    tag: {
      // A distinct surface from the row, with the kind colour as its border, so
      // the TYPE column reads as a column instead of loose chips.
      backgroundColor: theme.colors.surface1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: accent,
      borderRadius: 4,
      paddingHorizontal: 5,
      paddingVertical: 1,
      alignSelf: "flex-start",
      maxWidth: "100%",
    },
    tagText: {
      color: accent,
      fontSize: 10,
      fontVariant: ["tabular-nums"],
    },
  });
}

/** Wall-clock time the row ran, `HH:MM:SS` in the viewer's locale. */
export function TimeText(props: { startedAt: number | null | undefined; theme: PluginTheme }) {
  const { startedAt, theme } = props;
  return (
    <Text style={monoStyles(theme)} testID="time-text">
      {formatClockTime(startedAt)}
    </Text>
  );
}

/**
 * `HH:MM:SS` for a usable epoch-ms stamp, the dsh em dash otherwise. A row with
 * no time is a normal state (the recorder could not parse the event time), not
 * an error, so it renders the dash rather than a fabricated 00:00:00.
 */
export function formatClockTime(startedAt: number | null | undefined): string {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return "—";
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  // Some locales prefix a day-period marker even with hour12:false; keep the
  // last HH:MM:SS-looking token so the column stays fixed width.
  const match = parts.match(/(\d{1,2}:\d{2}:\d{2})/);
  return match?.[1] ?? "—";
}

/** Own-duration text: the dsh `—` when unknown (in-flight), else `N,NNN ms`. */
export function DurationText(props: { timeSeconds: number | null; theme: PluginTheme }) {
  const { timeSeconds, theme } = props;
  return (
    <Text style={monoStyles(theme)} testID="duration-text">
      {formatElapsedSeconds(timeSeconds)}
    </Text>
  );
}

/** Message token columns: `In N(cache) / out N`; `—` when the bucket is unknown. */
export function TokenText(props: {
  input?: number;
  cacheRead?: number;
  output?: number;
  think?: number;
  theme: PluginTheme;
}) {
  const { input, cacheRead, output, theme } = props;
  if (input === undefined && output === undefined) {
    return (
      <Text style={monoStyles(theme)} testID="token-text">
        token: —
      </Text>
    );
  }
  const cache = cacheRead === undefined ? "" : `(${cacheRead.toLocaleString("en-US")})`;
  return (
    <Text style={monoStyles(theme)} testID="token-text" numberOfLines={1}>
      {`In ${(input ?? 0).toLocaleString("en-US")}${cache} / out ${(output ?? 0).toLocaleString("en-US")}`}
    </Text>
  );
}

/** Tool output size: `N chars`; `—` when the size is unknown. */
export function CharsText(props: { outputChars: number | null; theme: PluginTheme }) {
  const { outputChars, theme } = props;
  return (
    <Text style={monoStyles(theme)} testID="chars-text" numberOfLines={1}>
      {outputChars === null ? "chars: —" : `${outputChars.toLocaleString("en-US")} chars`}
    </Text>
  );
}

function monoStyles(theme: PluginTheme): TextStyle {
  return {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  };
}

/** The sticky column header that sits directly under the toolbar. */
export function LedgerColumnHeader(props: { compact: boolean; theme: PluginTheme }) {
  const { compact, theme } = props;
  const columns = columnLayout(compact);
  const styles = useMemo(() => headerStyles(theme, columns), [theme, columns]);
  return (
    <View style={styles.row} testID="ledger-column-header">
      <Text style={styles.cell} testID="column-header-time">
        TIME
      </Text>
      <Text style={styles.cell} testID="column-header-type">
        TYPE
      </Text>
      <Text style={styles.cell} testID="column-header-context">
        CONTEXT
      </Text>
      <Text style={styles.cell} testID="column-header-stats">
        STATS
      </Text>
    </View>
  );
}

type Columns = ReturnType<typeof columnLayout>;

function headerStyles(theme: PluginTheme, columns: Columns) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: columns.gap,
      paddingLeft: columns.padLeft,
      paddingRight: 8,
      paddingVertical: 3,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    cell: {
      color: theme.colors.foregroundMuted,
      fontSize: 9,
      fontWeight: "600",
      letterSpacing: 0.4,
    },
  });
}

/** First line of an added slice, clipped to the column. */
function firstLine(text: string, limit = 160): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * CONTEXT for one row: what the row did, never the whole message.
 *
 * - tool: `name · argSummary`, unchanged.
 * - user: the prompt preview when the resolver has the text, else the label.
 * - message: only the characters THIS row added. A stream re-emits one message
 *   across many rows, so the cumulative label would repeat the entire message on
 *   every one of them; the row shows `+N chars` and, when the text is resolved,
 *   the slice that delta covers.
 */
export function cellContext(
  cell: TrajectoryCellProps,
  compact: boolean,
  resolvedText: string | undefined,
): string {
  const isTool = cell.kind === "tool" || cell.kind === "subtool";
  if (isTool) {
    if (cell.previewMarkdown === undefined) return cell.text;
    return `${cell.text} · ${compact ? "" : firstLine(cell.previewMarkdown)}`;
  }
  if (cell.kind === "message" && cell.deltaChars !== undefined) {
    const added =
      resolvedText === undefined || resolvedText.length === 0
        ? undefined
        : resolvedText.slice(cell.deltaStart ?? 0, (cell.deltaStart ?? 0) + cell.deltaChars);
    const head = added === undefined ? "" : firstLine(added);
    return head === "" ? `+${cell.deltaChars} chars` : `+${cell.deltaChars} chars · ${head}`;
  }
  if (resolvedText !== undefined && resolvedText.length > 0) return firstLine(resolvedText);
  return cell.text;
}

/** One ledger row: TIME | TYPE | CONTEXT | STATS, the four widths shared. */
export function TrajectoryCellRow(props: {
  cell: TrajectoryCellProps;
  compact: boolean;
  theme: PluginTheme;
  /**
   * Text fetched on demand for this row, when the resolver has it. Absent means
   * "not resolved yet" or "no key" — the row then keeps its length label, which
   * is a normal state and not an error.
   */
  resolvedText?: string | undefined;
  onPress?: (cell: TrajectoryCellProps) => void;
  testID?: string;
}) {
  const { cell, compact, theme, resolvedText, onPress, testID } = props;
  const columns = columnLayout(compact);
  const styles = useMemo(
    () => cellStyles(theme, cell.isError === true, columns),
    [theme, cell.isError, columns],
  );
  // Bound here (not inline in JSX): Pressable passes the press event as the
  // first argument, so an unbound handler would receive the event, not the cell.
  const handlePress = useCallback(() => {
    onPress?.(cell);
  }, [onPress, cell]);
  const railColor = useMemo(
    () => kindAccentColor(theme, cell.kind, cell.isError === true),
    [theme, cell.kind, cell.isError],
  );
  const railStyle = useMemo(
    () => [styles.rail, { backgroundColor: railColor }],
    [styles.rail, railColor],
  );
  const body = (
    <View style={styles.row} testID={testID}>
      <View style={railStyle} testID={`kind-rail-${cell.kind}`} />
      <Text style={styles.time} testID="col-time">
        {formatClockTime(cell.startedAt)}
      </Text>
      <View style={styles.type}>
        <KindTag kind={cell.kind} compact={compact} theme={theme} error={cell.isError === true} />
      </View>
      <Text style={styles.context} numberOfLines={1} testID="col-context">
        {cellContext(cell, compact, resolvedText)}
      </Text>
      <View style={styles.stats} testID="col-stats">
        <StatsCell cell={cell} theme={theme} />
      </View>
    </View>
  );
  if (onPress === undefined) return body;
  return (
    <Pressable accessibilityRole="button" onPress={handlePress}>
      {body}
    </Pressable>
  );
}

/**
 * STATS: the numbers this row added to the agent's context.
 *
 * - user: the prompt's character count.
 * - message: provider token buckets.
 * - tool: result characters and the call's own runtime.
 * Unknown values render the dsh em dash rather than a zero.
 */
function StatsCell(props: { cell: TrajectoryCellProps; theme: PluginTheme }) {
  const { cell, theme } = props;
  const toolStats = useMemo(
    () => ({ flexDirection: "row" as const, alignItems: "center" as const, gap: 6 }),
    [],
  );
  if (cell.kind === "user") {
    return (
      <Text style={monoStyles(theme)} testID="stats-text" numberOfLines={1}>
        {cell.textLength === undefined
          ? "chars: —"
          : `${cell.textLength.toLocaleString("en-US")} chars`}
      </Text>
    );
  }
  if (cell.kind === "message") {
    return (
      <TokenText
        input={cell.input}
        cacheRead={cell.cacheRead}
        output={cell.output}
        think={cell.think}
        theme={theme}
      />
    );
  }
  if (cell.kind === "tool" || cell.kind === "subtool") {
    return (
      <View style={toolStats}>
        <CharsText
          outputChars={cell.result === undefined ? null : Number.parseInt(cell.result, 10) || null}
          theme={theme}
        />
        <DurationText timeSeconds={cell.timeSeconds} theme={theme} />
      </View>
    );
  }
  return <DurationText timeSeconds={cell.timeSeconds} theme={theme} />;
}

function cellStyles(theme: PluginTheme, error: boolean, columns: Columns) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: columns.gap,
      minHeight: 26,
      paddingLeft: columns.padLeft,
      paddingRight: 8,
      paddingVertical: 2,
      backgroundColor: error ? theme.colors.surface1 : "transparent",
    },
    rail: {
      width: 3,
      alignSelf: "stretch",
      borderRadius: 1,
    },
    time: {
      width: columns.time,
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontVariant: ["tabular-nums"],
    },
    type: {
      width: columns.type,
      flexDirection: "row",
    },
    context: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
      fontSize: 12,
    },
    stats: {
      width: columns.stats,
      flexDirection: "row",
      justifyContent: "flex-end",
    },
  });
}
