import { useCallback, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
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
  rail: number;
  time: number;
  type: number;
  stats: number;
  gap: number;
  padLeft: number;
} {
  return compact
    ? { rail: 3, time: 52, type: 58, stats: 84, gap: 4, padLeft: 4 }
    : { rail: 3, time: 64, type: 68, stats: 150, gap: 8, padLeft: 6 };
}

type Columns = ReturnType<typeof columnLayout>;

/**
 * The per-column layout, as ONE object shared by the sticky header and every
 * body row.
 *
 * This is the single source of alignment. It previously existed only inside the
 * row styles, so the header inherited its widths in a comment and not in fact:
 * QC r18 measured the labels at x=7/39/70/122 against body values at
 * x=18/96/166/1372. Both sides now build from this, so they cannot drift.
 *
 * `context` is the one flexible column; the other three are fixed so a long tool
 * argument cannot shift the numbers sideways.
 */
function columnStyles(columns: Columns): Record<"time" | "type" | "context" | "stats", ViewStyle> {
  return {
    time: { width: columns.time },
    type: { width: columns.type },
    context: { flex: 1, minWidth: 0 },
    stats: { width: columns.stats },
  };
}

/**
 * Surface ladder, lightest first. Only theme tokens are used — no manufactured
 * or translucent colours (design.md) — so "one step darker" always means the
 * next entry here.
 */
const SURFACE_LADDER = ["transparent", "surface0", "surface1", "surface2"] as const;
type SurfaceToken = (typeof SURFACE_LADDER)[number];

/**
 * Base surface per kind. The tint says WHICH KIND a row is; the zebra below
 * says WHICH ROW it is. The rail and the kind tag stay the precise signal for
 * type, so these tints only have to separate broad groups.
 */
const KIND_SURFACE: Record<TrajectoryCellProps["kind"], SurfaceToken> = {
  user: "surface1",
  message: "surface0",
  tool: "transparent",
  system: "surface2",
  llm: "surface2",
  systemPrompt: "surface1",
  // Thinking sits with the other inferred/systemic rows; the rail and the tag
  // carry the distinction, not the tint.
  thinking: "surface0",
  context: "transparent",
  compacted: "transparent",
  subtool: "transparent",
};

/**
 * Background for one row.
 *
 * Precedence, applied in this order:
 *  1. A FAILED row is fixed at `surface1`. The failure wins the background: the
 *     statusDanger rail already says what happened, and letting the zebra move
 *     that surface would make the error row look like an ordinary alternate one.
 *  2. Otherwise the row's kind picks the base from the ladder.
 *  3. Then the ZEBRA steps the base ONE level darker for odd rows, capped at
 *     surface2. Stepping (rather than toggling between two fixed levels) keeps
 *     the mapping monotone and predictable: base + parity.
 *
 * Kinds already sitting at the cap (system, llm) do not move. The per-row
 * divider is what separates those, which is why the divider is not optional
 * polish here but part of this scheme.
 */
export function rowSurface(
  theme: PluginTheme,
  kind: TrajectoryCellProps["kind"],
  isError: boolean,
  zebraStep: 0 | 1,
): string {
  if (isError) return theme.colors.surface1;
  const base = KIND_SURFACE[kind] ?? "transparent";
  const start = SURFACE_LADDER.indexOf(base);
  const index = Math.min(start + zebraStep, SURFACE_LADDER.length - 1);
  const token = SURFACE_LADDER[index];
  return token === "transparent" ? "transparent" : theme.colors[token];
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
  // The derived round boundary is the one kind with no lane colour of its own:
  // it must not read as user/success, message/accent, tool/warning or a
  // failure, so it takes the foreground and separates by weight instead.
  if (kind === "llm") return theme.colors.foreground;
  if (kind === "systemPrompt") return theme.colors.foreground;
  // Reasoning is muted like system content: it is supporting material, not
  // something the reader is meant to act on.
  if (kind === "thinking") return theme.colors.foregroundMuted;
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
  llm: "L",
  systemPrompt: "P",
  thinking: "R",
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
      <View style={styles.rail} testID="column-header-rail" />
      <Text style={styles.time} testID="column-header-time">
        TIME
      </Text>
      <Text style={styles.type} testID="column-header-type">
        TYPE
      </Text>
      <Text style={styles.context} testID="column-header-context">
        CONTEXT
      </Text>
      <Text style={styles.stats} testID="column-header-stats">
        STATS
      </Text>
    </View>
  );
}

function headerStyles(theme: PluginTheme, columns: Columns) {
  const shared = columnStyles(columns);
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: columns.gap,
      paddingLeft: columns.padLeft,
      paddingRight: 8,
      paddingVertical: 3,
      // The header sits on the last row it labels, so its rule reads as the
      // table's top edge rather than as another row divider.
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    /**
     * Spacer for the per-row kind rail. A body row starts with the rail as its
     * first flex child, so a header that skipped it would sit `rail + gap` to
     * the left of the column it labels. Reserving the width here is what puts
     * TIME directly above TIME.
     */
    rail: { width: columns.rail },
    time: { ...shared.time, color: theme.colors.foregroundMuted, fontSize: 9, fontWeight: "600" },
    type: { ...shared.type, color: theme.colors.foregroundMuted, fontSize: 9, fontWeight: "600" },
    context: {
      ...shared.context,
      color: theme.colors.foregroundMuted,
      fontSize: 9,
      fontWeight: "600",
    },
    stats: { ...shared.stats, color: theme.colors.foregroundMuted, fontSize: 9, fontWeight: "600" },
  });
}

/** `K results` pulled back out of a round row's label, for its STATS column. */
function consumedResults(label: string): string {
  const match = label.match(/consumed (\d+) results/);
  return match?.[1] === undefined ? "results: —" : `${match[1]} results`;
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
  if (cell.kind === "thinking") return thinkingContext(cell);
  if (cell.kind === "tool" || cell.kind === "subtool") return toolContext(cell, compact);
  if (cell.kind === "message") {
    if ((cell.segments ?? 1) > 1) return mergedContext(cell, resolvedText);
    return messageDeltaContext(cell, resolvedText);
  }
  if (resolvedText !== undefined && resolvedText.length > 0) return firstLine(resolvedText);
  return cell.text;
}

/** Reasoning is a length, never a body: it arrives with no source key to fetch. */
function thinkingContext(cell: TrajectoryCellProps): string {
  return cell.textLength === undefined
    ? "reasoning · — chars total"
    : `reasoning · ${cell.textLength.toLocaleString("en-US")} chars total`;
}

function toolContext(cell: TrajectoryCellProps, compact: boolean): string {
  if (cell.previewMarkdown === undefined) return cell.text;
  return `${cell.text} · ${compact ? "" : firstLine(cell.previewMarkdown)}`;
}

/**
 * A merged response row's CONTEXT is the response's own first line, not any one
 * segment's delta slice -- that is the whole point of merging: the row speaks
 * for the response rather than for the chunk it happened to end on.
 */
function mergedContext(cell: TrajectoryCellProps, resolvedText: string | undefined): string {
  if (resolvedText !== undefined && resolvedText.length > 0) return firstLine(resolvedText);
  return cell.text;
}

/** An unmerged message row still shows only what its own delta added. */
function messageDeltaContext(cell: TrajectoryCellProps, resolvedText: string | undefined): string {
  if (cell.deltaChars === undefined) {
    if (resolvedText !== undefined && resolvedText.length > 0) return firstLine(resolvedText);
    return cell.text;
  }
  const start = cell.deltaStart ?? 0;
  const added =
    resolvedText === undefined || resolvedText.length === 0
      ? undefined
      : resolvedText.slice(start, start + cell.deltaChars);
  const head = added === undefined ? "" : firstLine(added);
  return head === "" ? `+${cell.deltaChars} chars` : `+${cell.deltaChars} chars · ${head}`;
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
  // `cell.index` is assigned by the fold over every row in arrival order, so it
  // increases monotonically down the list — which is exactly what a zebra needs.
  // No extra prop, and it stays correct as turns stream in.
  const zebraStep: 0 | 1 = cell.index % 2 === 1 ? 1 : 0;
  const styles = useMemo(
    () => cellStyles(theme, cell.isError === true, columns, zebraStep, cell.kind),
    [theme, cell.isError, columns, zebraStep, cell.kind],
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
      <View style={styles.type} testID="col-type">
        <KindTag kind={cell.kind} compact={compact} theme={theme} error={cell.isError === true} />
      </View>
      <Text
        style={cell.kind === "thinking" ? styles.contextItalic : styles.context}
        numberOfLines={1}
        testID="col-context"
      >
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
  // A derived round carries no numbers of its own: its STATS column reports the
  // facts that justify it — how many tool results it stands between.
  if (cell.kind === "thinking") {
    // One merged reasoning run: the count of stream events it stands for, since
    // the character total is already in CONTEXT.
    const merged = (cell.segments ?? 1) > 1;
    return (
      <Text style={monoStyles(theme)} testID="stats-text" numberOfLines={1}>
        {merged ? `${cell.segments} segments` : "—"}
      </Text>
    );
  }
  if (cell.kind === "llm") {
    return (
      <Text style={monoStyles(theme)} testID="stats-text" numberOfLines={1}>
        {consumedResults(cell.text)}
      </Text>
    );
  }
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
    // Merged rows still report tokens; the totals ride on the last segment that
    // carried usage, which is what the fold propagated.
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

function cellStyles(
  theme: PluginTheme,
  error: boolean,
  columns: Columns,
  zebraStep: 0 | 1,
  kind: TrajectoryCellProps["kind"],
) {
  const shared = columnStyles(columns);
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: columns.gap,
      minHeight: 26,
      paddingLeft: columns.padLeft,
      paddingRight: 8,
      paddingVertical: 2,
      // The hairline is the visual line break between rows (owner item 10); the
      // background carries type + order on top of it.
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      backgroundColor: rowSurface(theme, kind, error, zebraStep),
    },
    rail: {
      width: columns.rail,
      alignSelf: "stretch",
      borderRadius: 1,
    },
    time: {
      ...shared.time,
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontVariant: ["tabular-nums"],
    },
    type: { ...shared.type, flexDirection: "row" },
    context: { ...shared.context, color: theme.colors.foreground, fontSize: 12 },
    // Reasoning reads as supporting material: italic, and muted via the rail.
    contextItalic: {
      ...shared.context,
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      fontStyle: "italic",
    },
    stats: { ...shared.stats, flexDirection: "row", justifyContent: "flex-end" },
  });
}
