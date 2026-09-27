import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { CtxInjectChipData } from "../shared/ctx-schema.js";
import { t, tCount, type Locale } from "./i18n.js";

/**
 * Context-inject chip (C3): one row on the agent's chat timeline, expandable to
 * the per-field detail.
 *
 * Two things are deliberate here.
 *
 * 1. The row is a flex line whose summary text can be arbitrarily long, so it
 *    carries `flexShrink: 1` AND `minWidth: 0` together. On web a CSS flex item
 *    defaults to `min-width: auto`, which pins it to its intrinsic width and
 *    shoves the row's trailing edge off-screen even with shrink enabled; the two
 *    properties only work as a pair. This is the same defect the provider
 *    diagnostic sheet had, and the reason the pair is commented rather than
 *    left to look redundant.
 *
 * 2. Every unknown renders as an em dash. A resumed session never runs the
 *    create hook, so its prompt facts are genuinely unknown and saying "no system
 *    prompt" would be a fabricated claim.
 */

const LOCALE: Locale = "en";

/** Cap the MCP name list in the summary; the detail block shows them all. */
const SUMMARY_MCP_NAMES = 3;

function useStyles(theme: PluginTimelineItemProps<CtxInjectChipData>["theme"], compact: boolean) {
  const fontSize = compact ? 11 : 13;
  return {
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: compact ? 2 : 4,
    } satisfies ViewStyle,
    badge: {
      // flexShrink 0 so the label never competes with the summary for room.
      flexShrink: 0,
      color: theme.colors.accent,
      fontSize: compact ? 10 : 12,
      fontWeight: "600",
    } satisfies TextStyle,
    // The C2b pair. See the note above before changing either value.
    summary: {
      flexShrink: 1,
      minWidth: 0,
      color: theme.colors.foregroundMuted,
      fontSize,
    } satisfies TextStyle,
    caveat: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 10 : 11,
    } satisfies TextStyle,
    detail: {
      marginTop: 4,
      padding: compact ? 6 : 8,
      borderRadius: 6,
      backgroundColor: theme.colors.surface1,
      gap: 2,
    } satisfies ViewStyle,
    detailText: {
      color: theme.colors.foregroundMuted,
      fontSize: compact ? 10 : 11,
    } satisfies TextStyle,
    detailLabel: {
      color: theme.colors.foreground,
      fontSize: compact ? 10 : 11,
    } satisfies TextStyle,
  };
}

function promptSummary(data: CtxInjectChipData): string {
  if (data.systemPromptInjected === null) return t(LOCALE, "promptUnknown");
  if (!data.systemPromptInjected) return t(LOCALE, "promptAbsent");
  return t(LOCALE, "promptSummary", { count: data.systemPromptLength ?? 0 });
}

function promptDetail(data: CtxInjectChipData): string {
  if (data.systemPromptInjected === null) return t(LOCALE, "detailPromptUnknown");
  if (!data.systemPromptInjected) return t(LOCALE, "detailPromptNotConfigured");
  return t(LOCALE, "detailPromptValue", {
    count: data.systemPromptLength ?? 0,
    hash: data.systemPromptHash ?? t(LOCALE, "unknown"),
  });
}

function mcpSummary(data: CtxInjectChipData): string {
  const count = data.mcpServers.length;
  if (count === 0) return t(LOCALE, "mcpNone");
  const names = data.mcpServers.slice(0, SUMMARY_MCP_NAMES).join(", ");
  const rest = count > SUMMARY_MCP_NAMES ? ` +${count - SUMMARY_MCP_NAMES}` : "";
  return `${tCount(LOCALE, "mcpSummary", count)} (${names}${rest})`;
}

function yesNo(value: boolean | null): string {
  if (value === null) return t(LOCALE, "unknown");
  return t(LOCALE, value ? "yes" : "no");
}

function capturedLabel(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return t(LOCALE, "unknown");
  return new Date(parsed).toISOString().replace("T", " ").slice(0, 16);
}

export function CtxInjectChip({ item, theme, layout }: PluginTimelineItemProps<CtxInjectChipData>) {
  const data = item.data;
  const [expanded, setExpanded] = useState(false);
  const styles = useStyles(theme, layout.compact);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={`${t(LOCALE, "badge")}: ${promptSummary(data)}`}
        onPress={toggleExpanded}
        testID="ctx-inject-toggle"
      >
        <View style={styles.row}>
          <Text style={styles.badge}>{t(LOCALE, "badge")}</Text>
          <Text style={styles.summary} numberOfLines={1} testID="ctx-inject-summary">
            {`· ${promptSummary(data)} · ${mcpSummary(data)}`}
          </Text>
        </View>
      </Pressable>

      {/* Always visible, never behind the toggle: a caveat the user has to go
          looking for is not a disclosure. */}
      <Text style={styles.caveat} testID="ctx-inject-caveat">
        {t(LOCALE, "caveat")}
      </Text>

      {expanded ? (
        <View style={styles.detail} testID="ctx-inject-detail">
          <Detail label={t(LOCALE, "detailPrompt")} value={promptDetail(data)} styles={styles} />
          <Detail
            label={t(LOCALE, "detailMcp")}
            value={data.mcpServers.length > 0 ? data.mcpServers.join(", ") : t(LOCALE, "unknown")}
            styles={styles}
          />
          <Detail
            label={t(LOCALE, "detailPaseoTools")}
            value={yesNo(data.paseoToolsInjected)}
            styles={styles}
          />
          <Detail
            label={t(LOCALE, "detailModel")}
            value={data.model ?? t(LOCALE, "unknown")}
            styles={styles}
          />
          <Detail
            label={t(LOCALE, "detailMode")}
            value={data.modeId ?? t(LOCALE, "unknown")}
            styles={styles}
          />
          <Detail label={t(LOCALE, "detailSession")} value={data.reason} styles={styles} />
          <Detail
            label={t(LOCALE, "detailCaptured")}
            value={capturedLabel(data.capturedAt)}
            styles={styles}
          />
        </View>
      ) : null}
    </View>
  );
}

function Detail({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof useStyles>;
}) {
  return (
    <Text style={styles.detailText}>
      <Text style={styles.detailLabel}>{`${label}: `}</Text>
      {value}
    </Text>
  );
}
