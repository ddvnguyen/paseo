import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { formatElapsedSeconds } from "../shared/dsh/record.js";
import type { TrajectoryCellProps } from "../shared/dsh/record.js";

/**
 * Row cell primitives for the trajectory ledger (T2.2).
 * RN primitives + theme.colors only; every number renders through the ported
 * dsh formatters; unknown values render the dsh em dash. The kind tag
 * collapses to a single-character icon variant when `compact`.
 */

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
  const styles = useMemo(() => tagStyles(theme, error === true), [theme, error]);
  if (compact) {
    return (
      <View style={styles.tag} testID={`kind-tag-${kind}`}>
        <Text style={styles.tagText}>{KIND_ICON[kind]}</Text>
      </View>
    );
  }
  return (
    <View style={styles.tag} testID={`kind-tag-${kind}`}>
      <Text style={styles.tagText}>{kind}</Text>
    </View>
  );
}

function tagStyles(theme: PluginTheme, error: boolean) {
  return StyleSheet.create({
    tag: {
      backgroundColor: error ? theme.colors.statusDanger : theme.colors.surface2,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 1,
      alignSelf: "flex-start",
      minWidth: compactMinWidth(),
    },
    tagText: {
      color: error ? theme.colors.accentForeground : theme.colors.foregroundMuted,
      fontSize: 10,
      fontVariant: ["tabular-nums"],
    },
  });
}

function compactMinWidth(): number {
  return 14;
}

/** Own-duration text: the dsh `—` when unknown (in-flight), else `N,NNN ms`. */
export function DurationText(props: { timeSeconds: number | null; theme: PluginTheme }) {
  const { timeSeconds, theme } = props;
  return (
    <Text style={durationStyles(theme)} testID="duration-text">
      {formatElapsedSeconds(timeSeconds)}
    </Text>
  );
}

function durationStyles(theme: PluginTheme) {
  return StyleSheet.create({
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  });
}

/** Message token columns: `In N(cache) / out N`; `—` when the bucket is unknown. */
export function TokenText(props: {
  input?: number;
  cacheRead?: number;
  output?: number;
  think?: number;
  theme: PluginTheme;
}) {
  const { input, cacheRead, output, think, theme } = props;
  if (input === undefined && output === undefined) {
    return (
      <Text style={tokenStyles(theme)} testID="token-text">
        token: —
      </Text>
    );
  }
  const cache = cacheRead === undefined ? "" : `(${cacheRead.toLocaleString("en-US")})`;
  const thinkSuffix = think === undefined ? "" : ` · think ${think.toLocaleString("en-US")}`;
  return (
    <Text style={tokenStyles(theme)} testID="token-text">
      {`token: In ${(input ?? 0).toLocaleString("en-US")}${cache} / out ${(output ?? 0).toLocaleString("en-US")}${thinkSuffix}`}
    </Text>
  );
}

function tokenStyles(theme: PluginTheme) {
  return StyleSheet.create({
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  });
}

/** Tool output size: `characters: N`; `—` when the size is unknown. */
export function CharsText(props: { outputChars: number | null; theme: PluginTheme }) {
  const { outputChars, theme } = props;
  return (
    <Text style={charsStyles(theme)} testID="chars-text">
      {outputChars === null
        ? "characters: —"
        : `characters: ${outputChars.toLocaleString("en-US")}`}
    </Text>
  );
}

function charsStyles(theme: PluginTheme) {
  return StyleSheet.create({
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  });
}

/** One ledger cell row: kind tag + text + trailing metrics. */
export function TrajectoryCellRow(props: {
  cell: TrajectoryCellProps;
  compact: boolean;
  theme: PluginTheme;
  onPress?: () => void;
  testID?: string;
}) {
  const { cell, compact, theme, onPress, testID } = props;
  const styles = useMemo(() => cellStyles(theme, cell.isError === true), [theme, cell.isError]);
  const body = (
    <View style={styles.row} testID={testID}>
      <KindTag kind={cell.kind} compact={compact} theme={theme} error={cell.isError === true} />
      <View style={styles.body}>
        <Text numberOfLines={1} style={styles.text}>
          {cell.previewMarkdown === undefined
            ? cell.text
            : `${cell.text} · ${compact ? "" : cell.previewMarkdown}`}
        </Text>
        <View style={styles.metrics}>
          {cell.kind === "message" ? (
            <TokenText
              input={cell.input}
              cacheRead={cell.cacheRead}
              output={cell.output}
              think={cell.think}
              theme={theme}
            />
          ) : null}
          {cell.kind === "tool" || cell.kind === "subtool" ? (
            <CharsText
              outputChars={
                cell.result === undefined ? null : Number.parseInt(cell.result, 10) || null
              }
              theme={theme}
            />
          ) : null}
          <DurationText timeSeconds={cell.timeSeconds} theme={theme} />
        </View>
      </View>
    </View>
  );
  if (onPress === undefined) return body;
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      {body}
    </Pressable>
  );
}

function cellStyles(theme: PluginTheme, error: boolean) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
      minHeight: 30,
      paddingHorizontal: 8,
      paddingVertical: 2,
      backgroundColor: error ? theme.colors.surface1 : "transparent",
    },
    body: {
      flex: 1,
      flexDirection: "column",
      gap: 1,
    },
    text: {
      color: theme.colors.foreground,
      fontSize: 12,
    },
    metrics: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
  });
}
