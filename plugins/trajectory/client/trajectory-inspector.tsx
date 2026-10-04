import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { TrajectoryFoldRow } from "../shared/dsh/layout.js";
import { formatDurationMillis } from "../shared/dsh/record.js";
import { CharsText, KindTag, TokenText } from "./ledger-cells.js";
import {
  formatStartedAt,
  formatUnixSeconds,
  generationTime,
  recordStatus,
  statusLabel,
  throughput,
  timeToFirstToken,
  timingSource,
  tokenSplit,
  toolArgs,
  totalDuration,
} from "./inspector-fields.js";
import { useOpenElapsedMs } from "./use-elapsed-ticker.js";

/**
 * Row inspector (T2.3, dsh details-panel parity, observer-only).
 *
 * `row: null` renders nothing, so the inspector is closed by default and the
 * parent owns selection state. Unknown values render the dsh em dash — or, where
 * dsh states a reason instead of a number, that reason verbatim: "Not recorded",
 * "First token unavailable", "Usage unavailable". A field that says WHY it is
 * empty is worth more here than one that quietly shows nothing.
 *
 * Wide docks a 40%-width panel on the right edge — a share of the dialog, not a
 * fixed pixel width, so it stays proportionate from a laptop to a 4K display.
 * Compact covers the ledger with a full overlay (tags already collapse to icons
 * underneath). The caller reserves the matching width in its layout row, so the
 * two must stay in step.
 *
 * The field order and vocabulary follow dsh's summary + timing panels
 * (`TrajectoryTable.tsx` @ afd92680f2): status, when the row started, then
 * timing — the assistant block (total / TTFT / generation / throughput) for a
 * message row, and duration + timing source for everything else — then the
 * row's own facts. `inspector-fields.ts` owns every value decision; this file
 * owns the layout.
 *
 * `turn id`, not `turn`: providers reuse turn ids across sessions (QC r20
 * measured `opencode-turn-0` on two different turns), and the list numbers turns
 * positionally, so this is the raw id and the label says so. Anyone matching a
 * panel to a header wants the header's number, which the ledger owns.
 *
 * Message text is a DELTA summary by default. One assistant message arrives as
 * many ledger rows, so opening the inspector on any of them must not dump the
 * whole message; the full resolved text sits behind one button.
 */
export function TrajectoryInspector(props: {
  row: TrajectoryFoldRow | null;
  compact: boolean;
  theme: PluginTheme;
  /**
   * Full text for this row when the on-demand resolver has it. Absent keeps the
   * section out entirely rather than showing an empty panel, so a row with no
   * fetchable text looks exactly as it did before the resolver existed.
   */
  resolvedText?: string | undefined;
  onClose: () => void;
  testID?: string;
}) {
  const { row, compact, theme, resolvedText, onClose, testID } = props;
  // One clock for the panel: an open row's duration is the only value here that
  // moves, and it moves in the row too, so both read the same hook.
  const openMs = useOpenElapsedMs(row !== null && row.open === true, row?.timeMs ?? null);
  if (row === null) return null;
  return (
    <View
      style={compact ? overlayStyles(theme) : dockedStyles(theme)}
      testID={testID ?? "trajectory-inspector"}
    >
      <View style={headerStyles(theme)}>
        <KindTag kind={row.kind} compact={compact} theme={theme} error={row.isError === true} />
        <Text numberOfLines={2} style={titleStyles(theme)} testID="inspector-label">
          {row.label}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="close"
          hitSlop={CLOSE_HIT_SLOP}
          onPress={onClose}
          style={closeButtonStyles(theme)}
          testID="inspector-close"
        >
          <Text style={closeStyles(theme)}>close</Text>
        </Pressable>
      </View>
      <Field label="status" theme={theme} testID="inspector-status">
        <Text style={valueStyles(theme)} testID="inspector-status-value">
          {statusLabel(recordStatus(row))}
        </Text>
      </Field>
      <StartedAtField epochMs={row.timeMs} theme={theme} />
      <TimingFields row={row} openMs={openMs} theme={theme} />
      <Field label="turn id" theme={theme} testID="inspector-turn">
        <Text style={valueStyles(theme)}>{row.turnId ?? "—"}</Text>
      </Field>
      <Field label="seq" theme={theme} testID="inspector-seq">
        <Text style={valueStyles(theme)}>#{row.seq}</Text>
      </Field>
      {row.derived === true ? (
        <Field label="origin" theme={theme} testID="inspector-origin">
          <Text style={valueStyles(theme)}>derived by the recorder</Text>
        </Field>
      ) : null}
      {resolvedText !== undefined && resolvedText.length > 0 ? (
        <MessageTextSection
          theme={theme}
          deltaChars={row.kind === "message" ? (row.deltaChars ?? undefined) : undefined}
          segments={row.segments}
          resolvedText={resolvedText}
        />
      ) : null}
      {row.kind === "tool" ? (
        <>
          <ToolArgsField label={row.label} theme={theme} />
          <Field label="output" theme={theme} testID="inspector-output">
            <CharsText outputChars={row.outputChars ?? null} theme={theme} />
          </Field>
          {row.callId === undefined ? null : (
            <Field label="call" theme={theme} testID="inspector-call">
              <Text style={valueStyles(theme)}>{row.callId}</Text>
            </Field>
          )}
          {/* dsh gives every tool record a Schema tab. Ours has no call-time
              tool schema to show, and saying so beats an absent section that
              reads as an oversight. */}
          <Field label="schema" theme={theme} testID="inspector-schema">
            <Text style={mutedValueStyles(theme)}>not recorded</Text>
          </Field>
        </>
      ) : null}
      {row.kind === "message" ? <MessageTokenFields row={row} theme={theme} /> : null}
    </View>
  );
}

/**
 * The timing block, split the way dsh splits it.
 *
 * A message row gets the assistant panel (total / TTFT / generation /
 * throughput); every other kind gets the plainer trio dsh's `RecordTiming` shows
 * for a non-assistant record: duration plus where the duration came from. The
 * split is not cosmetic — a tool call has no first token, so the assistant
 * panel's three unmeasured fields would be noise on it.
 */
function TimingFields(props: {
  row: TrajectoryFoldRow;
  /** Live ms for an open row; null once it has settled. */
  openMs: number | null;
  theme: PluginTheme;
}) {
  const { row, openMs, theme } = props;
  if (row.kind === "message") {
    return (
      <>
        <Field label="total" theme={theme} testID="inspector-total">
          <Text style={valueStyles(theme)}>{totalDuration(row)}</Text>
        </Field>
        <Field label="ttft" theme={theme} testID="inspector-ttft">
          <Text style={mutedValueStyles(theme)}>{timeToFirstToken(row)}</Text>
        </Field>
        <Field label="generation" theme={theme} testID="inspector-generation">
          <Text style={mutedValueStyles(theme)}>{generationTime(row)}</Text>
        </Field>
        <Field label="throughput" theme={theme} testID="inspector-throughput">
          <Text style={mutedValueStyles(theme)}>{throughput(row)}</Text>
        </Field>
      </>
    );
  }
  return (
    <>
      <Field label="duration" theme={theme} testID="inspector-duration">
        <Text style={valueStyles(theme)}>
          {formatDurationMillis(openMs === null ? row.durationMs : openMs)}
        </Text>
      </Field>
      <Field label="timing source" theme={theme} testID="inspector-timing-source">
        <Text style={mutedValueStyles(theme)}>{timingSource(row)}</Text>
      </Field>
    </>
  );
}

/**
 * When the row started, with dsh's local/unix toggle.
 *
 * The stamp is the row's own start, which for a tool call is the CALL time: the
 * fold anchors it there so the duration beside it reads call→result instead of
 * result→result.
 */
function StartedAtField(props: { epochMs: number | null; theme: PluginTheme }) {
  const { epochMs, theme } = props;
  const [unix, setUnix] = useState(false);
  const toggle = useCallback(() => setUnix((value) => !value), []);
  const styles = useMemo(() => startedStyles(theme), [theme]);
  return (
    <Field label="started" theme={theme} testID="inspector-started">
      <View style={styles.row}>
        <Text style={valueStyles(theme)} testID="inspector-started-value">
          {unix ? formatUnixSeconds(epochMs) : formatStartedAt(epochMs)}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Toggle timestamp format"
          onPress={toggle}
          style={styles.toggle}
          testID="inspector-started-toggle"
        >
          <Text style={styles.toggleLabel}>{unix ? "local" : "unix"}</Text>
        </Pressable>
      </View>
    </Field>
  );
}

/** A tool row's recorded call arguments: dsh's Payload, at summary fidelity. */
function ToolArgsField(props: { label: string; theme: PluginTheme }) {
  const { label, theme } = props;
  const args = toolArgs(label);
  if (args === null) return null;
  return (
    <Field label="args" theme={theme} testID="inspector-args">
      <Text numberOfLines={3} style={valueStyles(theme)}>
        {args}
      </Text>
    </Field>
  );
}

/**
 * A message row's tokens: our compact input/cache line plus dsh's split.
 *
 * The compact line answers "how big was this call"; the split answers "how much
 * of the output was reasoning", which is the number a reader of a long thinking
 * run actually wants and which the ledger records but used to hide.
 */
function MessageTokenFields(props: { row: TrajectoryFoldRow; theme: PluginTheme }) {
  const { row, theme } = props;
  const lines = tokenSplit(row);
  return (
    <>
      <Field label="tokens" theme={theme} testID="inspector-tokens">
        <TokenText
          input={row.usage?.input ?? undefined}
          cacheRead={row.usage?.cacheRead ?? undefined}
          output={row.usage?.output ?? undefined}
          think={row.usage?.think ?? undefined}
          theme={theme}
        />
      </Field>
      {lines.map((line) => (
        <Field key={line.label} label={line.label} theme={theme} testID={`inspector-${line.label}`}>
          <Text style={valueStyles(theme)}>{line.value}</Text>
        </Field>
      ))}
    </>
  );
}

/**
 * The message text block: a delta summary, with the full text one press away.
 *
 * `deltaChars` is what THIS ledger row contributed. With it the section leads
 * with the size of the addition; without it (a user row, or a message recorded
 * before deltas existed) it shows the resolved text's length so the section
 * still says something true.
 */
function MessageTextSection(props: {
  theme: PluginTheme;
  deltaChars: number | undefined;
  /** How many stream events this row merged; 1 when it is a single row. */
  segments: number | undefined;
  resolvedText: string;
}) {
  const { theme, deltaChars, segments, resolvedText } = props;
  const [showFull, setShowFull] = useState(false);
  const styles = useMemo(() => messageSectionStyles(theme), [theme]);
  // Bound and pre-built: a fresh object/closure per render would be a new prop
  // identity on every render of the section.
  const toggleState = useMemo(() => ({ expanded: showFull }), [showFull]);
  const togglePress = useCallback(() => setShowFull((value) => !value), []);
  const total = `${resolvedText.length.toLocaleString("en-US")} chars total`;
  const summary = messageSummary({ total, deltaChars, segments });
  return (
    <Field label="text" theme={theme} testID="inspector-text">
      <Text style={styles.summary} testID="inspector-text-summary">
        {summary}
      </Text>
      {showFull ? (
        /* Not numberOfLines: this is the one place the full payload is read. */
        <Text style={valueStyles(theme)} testID="inspector-text-full">
          {resolvedText}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={toggleState}
        onPress={togglePress}
        style={styles.toggle}
        testID="inspector-text-toggle"
      >
        <Text style={styles.toggleLabel}>{showFull ? "hide full text" : "show full text"}</Text>
      </Pressable>
    </Field>
  );
}

/**
 * The one line that says what this row stands for.
 *
 * A merged row replaces the per-chunk delta with the response total and how many
 * stream events it folded, because that is now the fact the row represents.
 */
function messageSummary(input: {
  total: string;
  deltaChars: number | undefined;
  segments: number | undefined;
}): string {
  if ((input.segments ?? 1) > 1) return `${input.total} · ${input.segments} segments merged`;
  if (input.deltaChars === undefined) return input.total;
  return `+${input.deltaChars.toLocaleString("en-US")} chars this row · ${input.total}`;
}

function messageSectionStyles(theme: PluginTheme) {
  return {
    summary: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
    } satisfies TextStyle,
    toggle: {
      alignSelf: "flex-start" as const,
      paddingVertical: 2,
    },
    toggleLabel: {
      color: theme.colors.accent,
      fontSize: 11,
    } satisfies TextStyle,
  };
}

function Field(props: {
  label: string;
  theme: PluginTheme;
  testID: string;
  children: React.ReactNode;
}) {
  const { label, theme, testID, children } = props;
  return (
    <View style={fieldStyles()} testID={testID}>
      <Text style={fieldLabelStyles(theme)}>{label}</Text>
      {children}
    </View>
  );
}

// Plain style objects (not StyleSheet.create): web create takes
// named-style dicts only — a flat object throws in its WeakMap cache.
// Spreading absoluteFillObject is fine here: these ARE the style props.
function overlayStyles(theme: PluginTheme): ViewStyle {
  return {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.surface0,
    padding: 12,
    gap: 8,
  };
}

/**
 * Dock width as a share of the dialog. Exported so the panel's layout spacer
 * reserves exactly the same width; two literals would drift.
 */
export const DOCK_WIDTH = "40%";

function dockedStyles(theme: PluginTheme): ViewStyle {
  return {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: DOCK_WIDTH,
    backgroundColor: theme.colors.surface0,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border,
    padding: 12,
    gap: 8,
  };
}

function headerStyles(theme: PluginTheme): ViewStyle {
  return {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  };
}

function titleStyles(theme: PluginTheme): TextStyle {
  return {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: 13,
    fontWeight: "600",
  };
}

/**
 * Minimum comfortable target, matching the host sheet's own floor for its close
 * control.
 */
const CLOSE_TARGET = 44;
/** Keeps the painted button small while the target stays CLOSE_TARGET. */
const CLOSE_PAINTED = 32;
const CLOSE_HIT_SLOP = (CLOSE_TARGET - CLOSE_PAINTED) / 2;

/**
 * A text button's box is whatever the glyph measures, so the padding pins it to
 * a known size. Without it the hit area equals the text (QC r18 measured a
 * 32x32 border box and nothing larger), and `hitSlop` on top of an unpinned box
 * cannot be reasoned about: the same number that takes a 32px box to 44px leaves
 * a 14px-tall text row well short.
 *
 * `hitSlop` grows the touch/hit rect without changing layout or painting, which
 * is the whole point -- the button stays visually compact in the header.
 */
function closeButtonStyles(_theme: PluginTheme): ViewStyle {
  const side = (CLOSE_PAINTED - 24) / 2;
  return {
    paddingVertical: Math.max(0, side),
    paddingHorizontal: Math.max(0, side),
    borderRadius: 4,
    justifyContent: "center",
    alignItems: "center",
    // Painted on the header's own surface, so the larger target stays invisible.
    backgroundColor: "transparent",
  };
}

function closeStyles(theme: PluginTheme): TextStyle {
  return {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
  };
}

function fieldStyles(): ViewStyle {
  return {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 12,
  };
}

function fieldLabelStyles(theme: PluginTheme): TextStyle {
  return {
    width: 72,
    color: theme.colors.foregroundMuted,
    fontSize: 11,
  };
}

function valueStyles(theme: PluginTheme): TextStyle {
  return {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  };
}

/**
 * A field whose value is a REASON rather than a measurement.
 *
 * dsh's detail panel is full of these — "Not recorded", "First token
 * unavailable", "Usage unavailable" — and they read as muted text, not as the
 * primary value of the row. Painting them in `foreground` would make a gap look
 * like a result.
 */
function mutedValueStyles(theme: PluginTheme): TextStyle {
  return {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: 12,
  };
}

/** The stamp plus its format toggle, on one line. */
function startedStyles(theme: PluginTheme) {
  return {
    row: {
      flex: 1,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
    },
    toggle: {
      alignSelf: "flex-start" as const,
      paddingVertical: 2,
    },
    toggleLabel: {
      color: theme.colors.accent,
      fontSize: 11,
    } satisfies TextStyle,
  };
}
