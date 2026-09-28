import { Pressable, StyleSheet, Text, View } from "react-native";
import type { TextStyle, ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { TrajectoryFoldRow } from "../shared/dsh/layout.js";
import { formatDurationMillis } from "../shared/dsh/record.js";
import { CharsText, KindTag, TokenText } from "./ledger-cells.js";

/**
 * Row inspector (T2.3, dsh details-panel parity, observer-only).
 *
 * Pure and props-driven: `row: null` renders nothing, so the inspector is
 * closed by default and the parent owns selection state. Unknown values
 * render the dsh em dash; in-flight rows (null duration) show "—".
 * Wide docks a 320pt panel on the right edge; compact covers the ledger
 * with a full overlay (tags already collapse to icons underneath).
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
        <Pressable accessibilityRole="button" onPress={onClose} testID="inspector-close">
          <Text style={closeStyles(theme)}>close</Text>
        </Pressable>
      </View>
      <Field label="seq" theme={theme} testID="inspector-seq">
        <Text style={valueStyles(theme)}>#{row.seq}</Text>
      </Field>
      <Field label="turn" theme={theme} testID="inspector-turn">
        <Text style={valueStyles(theme)}>{row.turnId ?? "—"}</Text>
      </Field>
      <Field label="step" theme={theme} testID="inspector-step">
        <Text style={valueStyles(theme)}>
          {row.step === null || row.step === undefined ? "—" : `Step ${row.step}`}
        </Text>
      </Field>
      <Field label="duration" theme={theme} testID="inspector-duration">
        <Text style={valueStyles(theme)}>{formatDurationMillis(row.durationMs)}</Text>
      </Field>
      {resolvedText !== undefined && resolvedText.length > 0 ? (
        <Field label="text" theme={theme} testID="inspector-text">
          {/* Not numberOfLines: the inspector is where the full payload is read. */}
          <Text style={valueStyles(theme)}>{resolvedText}</Text>
        </Field>
      ) : null}
      {row.kind === "tool" ? (
        <>
          <Field label="output" theme={theme} testID="inspector-output">
            <CharsText outputChars={row.outputChars ?? null} theme={theme} />
          </Field>
          <Field label="status" theme={theme} testID="inspector-error">
            <Text style={valueStyles(theme)}>{errorLabel(row.isError)}</Text>
          </Field>
          {row.callId === undefined ? null : (
            <Field label="call" theme={theme} testID="inspector-call">
              <Text style={valueStyles(theme)}>{row.callId}</Text>
            </Field>
          )}
        </>
      ) : null}
      {row.kind === "message" && row.usage !== undefined ? (
        <Field label="tokens" theme={theme} testID="inspector-tokens">
          <TokenText
            input={row.usage.input ?? undefined}
            cacheRead={row.usage.cacheRead ?? undefined}
            output={row.usage.output ?? undefined}
            think={row.usage.think ?? undefined}
            theme={theme}
          />
        </Field>
      ) : null}
    </View>
  );
}

function errorLabel(isError: boolean | undefined): string {
  if (isError === true) return "error";
  if (isError === false) return "ok";
  return "—";
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

function dockedStyles(theme: PluginTheme): ViewStyle {
  return {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: 320,
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
