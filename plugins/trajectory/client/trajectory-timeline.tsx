import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { TrajectoryTimelineSpan } from "../shared/dsh/timeline.js";
import { deriveTrajectoryTimeline } from "../shared/dsh/timeline.js";
import type { TrajectoryTurnModel } from "../shared/dsh/layout.js";
import { formatDurationMillis } from "../shared/dsh/record.js";

/**
 * dsh-parity gantt strip: three lanes (Input / Model / Tools) of static bars
 * above the ledger, wired to the ported `deriveTrajectoryTimeline`.
 *
 * Two projections, matching the dsh toolbar's Duration toggle: `sequence` lays
 * every record out at equal width in arrival order, `actual` lays them out on the
 * real clock. The toggle changes the projection — it does not show and hide the
 * strip — so the strip is always on and the two modes are directly comparable.
 *
 * Still static: no drag and no zoom. It is now interactive in three small ways,
 * all of them read-only or selection-only:
 *
 * - TOOLTIP. Desktop hover and phone tap both reveal the record's type, label and
 *   own duration. Hover is tracked on a plain `View` with pointer enter/leave
 *   (docs/hover.md failure mode 1: a `Pressable` carrying its own hover state
 *   machine fights any nested `Pressable`), and press lives on a separate inner
 *   `Pressable`. Native has no hover at all, so on a phone the tooltip is a tap
 *   target instead; tapping the same bar again, or another one, dismisses or
 *   moves it.
 * - HIGHLIGHT. The selected ledger row's bar is outlined. The outline is the
 *   selection affordance and never replaces the bar's own colour, so a failed
 *   record still reads as statusDanger while selected.
 * - TAP TO DETAIL. Pressing a bar selects its row, which is what opens the
 *   inspector. A record the producer gave no source seq has nothing to select
 *   against, so it is hoverable but not selectable — no fabricated target.
 *
 * `platform` comes from the host's layout contract rather than a Platform sniff,
 * so the strip never has to guess which surface it is on.
 *
 * Plain themed style objects, not StyleSheet.create — the themed-factory form
 * re-registers on every theme (the c05e19c24 react-native-web WeakMap hazard).
 */

const LANES = [
  { key: "input", label: "Input", lane: 0 },
  { key: "model", label: "Model", lane: 1 },
  { key: "tools", label: "Tools", lane: 2 },
] as const;

/** Which surface the strip is on. Omitted means "assume a phone". */
export type TimelinePlatform = "ios" | "android" | "web";

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
  /**
   * Source seq of the selected ledger row, so its bar is outlined. Optional:
   * without it nothing is highlighted and the strip behaves as before.
   */
  selectedSeq?: number | null;
  /** Called with a record's source seq when its bar is pressed. */
  onSelectSpan?: (sourceSeq: number) => void;
  /**
   * Hover-tooltip on web, tap-tooltip everywhere. Omitted means tap-only, which
   * is the safe default: a stray hover path on a phone would never fire anyway,
   * but a stray tap path on desktop would.
   */
  platform?: TimelinePlatform;
}) {
  const { turns, actualDuration, compact, theme, selectedSeq, onSelectSpan, platform } = props;
  const model = useMemo(
    () => deriveTrajectoryTimeline(turns, actualDuration ? "actual" : "sequence"),
    [turns, actualDuration],
  );
  const styles = useMemo(() => stripStyles(theme, compact), [theme, compact]);
  // Hover is tracked by index; the tooltip reads a separate tap target so a
  // phone can reach it and a desktop press does not fight the hover state.
  const [hovered, setHovered] = useState<number | null>(null);
  const [tapped, setTapped] = useState<number | null>(null);
  const hoverEnabled = platform === "web";

  const handleHover = useCallback(
    (index: number) => () => {
      if (hoverEnabled) setHovered(index);
    },
    [hoverEnabled],
  );
  const handleUnhover = useCallback(() => {
    if (hoverEnabled) setHovered(null);
  }, [hoverEnabled]);

  const handlePress = useCallback(
    (span: TrajectoryTimelineSpan) => () => {
      // Tap-again dismisses; a different bar moves the tooltip and the selection.
      setTapped((previous) => (previous === span.index ? null : span.index));
      if (span.sourceSeq !== undefined) onSelectSpan?.(span.sourceSeq);
    },
    [onSelectSpan],
  );

  if (model === null) return null;

  const duration = model.end - model.start;
  // An explicit tap wins over hover: it is the only way to see this on a phone.
  const activeIndex = tapped ?? (hoverEnabled ? hovered : null);
  const activeSpan =
    activeIndex === null ? null : (model.spans.find((span) => span.index === activeIndex) ?? null);

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
                  selected={
                    selectedSeq !== undefined &&
                    selectedSeq !== null &&
                    span.sourceSeq === selectedSeq
                  }
                  onHover={handleHover(span.index)}
                  onUnhover={handleUnhover}
                  onPress={handlePress(span)}
                />
              ))}
          </View>
        </View>
      ))}
      {activeSpan === null ? null : <TimelineTooltip span={activeSpan} styles={styles} />}
    </View>
  );
}

function Span(props: {
  span: TrajectoryTimelineSpan;
  duration: number;
  theme: PluginTheme;
  styles: ReturnType<typeof stripStyles>;
  selected: boolean;
  onHover: () => void;
  onUnhover: () => void;
  onPress: () => void;
}) {
  const { span, duration, theme, styles, selected, onHover, onUnhover, onPress } = props;
  // `start` is already domain-relative, so left is the offset and width the
  // record's own extent. A zero-length record still gets a visible minimum.
  const left = percentOf(span.start, duration);
  const widthPercent = percentOf(span.end - span.start, duration);
  // Built once per span and memoised on its inputs, so the array is never a fresh
  // literal in render (react-perf jsx-no-new-array-as-prop).
  // A fresh object/closure per render would be a new prop identity every time.
  const a11yState = useMemo(() => ({ selected }), [selected]);
  const a11yLabel = useMemo(() => `${span.kind} ${span.label}`, [span.kind, span.label]);
  const selectable = span.sourceSeq !== undefined;
  const a11yHint = useMemo(() => (selectable ? undefined : "no record to open"), [selectable]);
  const barStyle = useMemo<ViewStyle[]>(
    () => [
      styles.span,
      {
        left,
        width: widthPercent,
        minWidth: 2,
        backgroundColor: laneColor(theme, span.lane, span.isError),
        // Outline, not fill: selection must stay readable on a failed record.
        ...(selected ? { borderWidth: 1, borderColor: theme.colors.accent } : {}),
      },
    ],
    [styles.span, left, widthPercent, theme, span.lane, span.isError, selected],
  );
  // Hover on a plain View, press on a separate inner Pressable (docs/hover.md).
  return (
    <View
      style={styles.hoverTarget}
      onPointerEnter={onHover}
      onPointerLeave={onUnhover}
      testID={`timeline-hover-${span.index}`}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        accessibilityState={a11yState}
        disabled={!selectable}
        accessibilityHint={a11yHint}
        onPress={onPress}
        style={barStyle}
        testID={`timeline-span-${span.index}`}
      />
    </View>
  );
}

/**
 * The tooltip. Rendered once for the whole strip rather than per bar, so it
 * cannot be clipped by a lane's bounds and there is only ever one.
 */
function TimelineTooltip(props: {
  span: TrajectoryTimelineSpan;
  styles: ReturnType<typeof stripStyles>;
}) {
  const { span, styles } = props;
  return (
    <View style={styles.tooltip} testID="timeline-tooltip">
      <Text style={styles.tooltipKind} testID="timeline-tooltip-kind">
        {span.kind}
        {span.isError ? " · error" : ""}
      </Text>
      <Text style={styles.tooltipLabel} numberOfLines={2} testID="timeline-tooltip-label">
        {span.label}
      </Text>
      <Text style={styles.tooltipDuration} testID="timeline-tooltip-duration">
        {formatDurationMillis(span.durationMs)}
      </Text>
    </View>
  );
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
    // Sealed hover envelope: it exists only to be the hover target and carries no
    // layout of its own, so the bar inside keeps its absolute placement.
    hoverTarget: {
      position: "absolute",
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    } satisfies ViewStyle,
    span: {
      position: "absolute",
      top: 0,
      bottom: 0,
      borderRadius: 1,
    } satisfies ViewStyle,
    tooltip: {
      position: "absolute",
      top: 0,
      right: 8,
      maxWidth: 260,
      paddingHorizontal: 6,
      paddingVertical: 4,
      gap: 1,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 4,
      backgroundColor: theme.colors.surface1,
      zIndex: 10,
    } satisfies ViewStyle,
    tooltipKind: {
      color: theme.colors.foregroundMuted,
      fontSize: 9,
      fontWeight: "600",
      letterSpacing: 0.4,
    } satisfies TextStyle,
    tooltipLabel: {
      color: theme.colors.foreground,
      fontSize: 11,
    } satisfies TextStyle,
    tooltipDuration: {
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontVariant: ["tabular-nums"],
    } satisfies TextStyle,
  };
}
