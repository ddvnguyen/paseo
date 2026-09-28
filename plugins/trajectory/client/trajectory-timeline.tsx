import { useMemo } from "react";
import { Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { TrajectoryTimelineSpan } from "../shared/dsh/timeline.js";
import { deriveTrajectoryTimeline } from "../shared/dsh/timeline.js";
import type { TrajectoryTurnModel } from "../shared/dsh/layout.js";

/**
 * dsh-parity gantt strip: three lanes (Input / Model / Tools) of static bars
 * above the ledger, wired to the ported `deriveTrajectoryTimeline` that was
 * previously imported by nothing.
 *
 * Two projections, matching the dsh toolbar's Duration toggle: `sequence` lays
 * every record out at equal width in arrival order, `actual` lays them out on the
 * real clock. The toggle changes the projection — it does not show and hide the
 * strip — so the strip is always on and the two modes are directly comparable.
 *
 * Static bars only: no drag, zoom, selection or tooltip (explicitly out of scope
 * for v1). Lane colours are the existing theme tokens; an error record keeps the
 * lane colour's position but reads as statusDanger so a failure is visible
 * without a tooltip.
 *
 * Plain themed style objects, not StyleSheet.create — the themed-factory form
 * re-registers on every theme (the c05e19c24 react-native-web WeakMap hazard).
 */

const LANES = [
  { key: "input", label: "Input", lane: 0 },
  { key: "model", label: "Model", lane: 1 },
  { key: "tools", label: "Tools", lane: 2 },
] as const;

/**
 * Percentage of the domain, clamped. Returns the template-literal form RN's
 * `DimensionValue` expects — a plain `string` does not satisfy `left`/`width`.
 */
function percentOf(value: number, total: number): `${number}%` {
  if (total <= 0) return "0%";
  const clamped = Math.max(0, Math.min(100, (value / total) * 100));
  // toFixed returns `string`, which would widen the template to `${string}%`;
  // going back through Number keeps the `${number}%` literal type.
  return `${Number(clamped.toFixed(3))}%`;
}

function laneColor(theme: PluginTheme, lane: number, isError: boolean): string {
  if (isError) return theme.colors.statusDanger;
  if (lane === 2) return theme.colors.statusWarning;
  if (lane === 1) return theme.colors.accent;
  return theme.colors.foregroundMuted;
}

export function TrajectoryTimelineStrip(props: {
  turns: readonly TrajectoryTurnModel[];
  actualDuration: boolean;
  compact: boolean;
  theme: PluginTheme;
}) {
  const { turns, actualDuration, compact, theme } = props;
  const model = useMemo(
    () => deriveTrajectoryTimeline(turns, actualDuration ? "actual" : "sequence"),
    [turns, actualDuration],
  );
  const styles = useMemo(() => stripStyles(theme, compact), [theme, compact]);

  if (model === null) return null;

  const duration = model.end - model.start;
  return (
    <View style={styles.root} testID="trajectory-timeline">
      <Text style={styles.mode} testID="trajectory-timeline-mode">
        {actualDuration ? "actual time" : "sequence"}
      </Text>
      {LANES.map(({ key, label, lane }) => (
        <View key={key} style={styles.lane} testID={`timeline-lane-${key}`}>
          <Text style={styles.laneLabel}>{label}</Text>
          <View style={styles.track}>
            {model.spans
              .filter((span) => span.lane === lane)
              .map((span) => (
                <Span
                  key={span.index}
                  span={span}
                  duration={duration}
                  theme={theme}
                  styles={styles}
                />
              ))}
          </View>
        </View>
      ))}
    </View>
  );
}

function Span(props: {
  span: TrajectoryTimelineSpan;
  duration: number;
  theme: PluginTheme;
  styles: ReturnType<typeof stripStyles>;
}) {
  const { span, duration, theme, styles } = props;
  // `start` is already domain-relative, so left is the offset and width the
  // record's own extent. A zero-length record still gets a visible minimum.
  const left = percentOf(span.start, duration);
  const widthPercent = percentOf(span.end - span.start, duration);
  // Built once per span and memoised on its inputs, so the array is never a fresh
  // literal in render (react-perf jsx-no-new-array-as-prop).
  const barStyle = useMemo<ViewStyle[]>(
    () => [
      styles.span,
      {
        left,
        width: widthPercent,
        minWidth: 2,
        backgroundColor: laneColor(theme, span.lane, span.isError),
      },
    ],
    [styles.span, left, widthPercent, theme, span.lane, span.isError],
  );
  return <View style={barStyle} testID={`timeline-span-${span.index}`} />;
}

function stripStyles(theme: PluginTheme, compact: boolean) {
  return {
    root: {
      paddingHorizontal: 8,
      paddingBottom: 4,
      gap: 2,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    } satisfies ViewStyle,
    mode: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 9 : 10,
    } satisfies TextStyle,
    lane: { flexDirection: "row", alignItems: "center", gap: 6 } satisfies ViewStyle,
    laneLabel: {
      width: 38,
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 9 : 10,
    } satisfies TextStyle,
    track: {
      flex: 1,
      minWidth: 0,
      // C2b lesson: a shrinking flex child needs minWidth 0 or it refuses to
      // give up its intrinsic width and pushes the row wide.
      minHeight: 8,
      position: "relative",
    } satisfies ViewStyle,
    span: {
      position: "absolute",
      top: 0,
      bottom: 0,
      borderRadius: 1,
    } satisfies ViewStyle,
  };
}
