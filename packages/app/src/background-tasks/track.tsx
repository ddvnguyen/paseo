import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ChevronDown, ChevronRight, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

function truncateCommand(command: string | null, maxLen = 60): string {
  if (!command) return "(no command)";
  const trimmed = command.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen)}…`;
}

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - Date.parse(startedAt);
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export interface BackgroundTasksTrackProps {
  tasks: BackgroundTaskDescriptorPayload[];
}

const TASKS_LIST_MAX_HEIGHT = 200;

export function BackgroundTasksTrack({ tasks }: BackgroundTasksTrackProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((current) => !current);
  }, []);

  const headerLabel = useMemo(() => {
    const running = tasks.filter((t) => t.status === "running").length;
    const total = tasks.length;
    if (total === 0) {
      return "No background tasks";
    }
    const parts = [`${total} ${total === 1 ? "background task" : "background tasks"}`];
    if (running > 0) {
      parts.push(`${running} running`);
    }
    return parts.join(" · ");
  }, [tasks]);

  const surfaceStyle = useMemo(
    () => [styles.surface, expanded && styles.surfaceExpanded],
    [expanded],
  );

  const headerContainerStyle = useMemo(
    () => [styles.header, expanded ? styles.headerDivider : styles.headerCollapsed],
    [expanded],
  );

  return (
    <View style={styles.outer} testID="background-tasks-track">
      <View style={styles.track}>
        <View style={surfaceStyle}>
          <View style={headerContainerStyle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={headerLabel}
              testID="background-tasks-track-header"
              onPress={toggleExpanded}
              style={styles.headerToggle}
            >
              {expanded ? (
                <ThemedChevronDown size={12} uniProps={foregroundMutedColorMapping} />
              ) : (
                <ThemedChevronRight size={12} uniProps={foregroundMutedColorMapping} />
              )}
              <Text style={styles.headerLabel} numberOfLines={1}>
                {headerLabel}
              </Text>
            </Pressable>
          </View>
          {expanded && tasks.length > 0 ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {tasks.map((task) => (
                <BackgroundTaskRow key={task.id} task={task} />
              ))}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function BackgroundTaskRow({ task }: { task: BackgroundTaskDescriptorPayload }): ReactElement {
  return (
    <View style={styles.row}>
      <StatusDot status={task.status} />
      <ThemedSquareTerminal size={14} uniProps={foregroundMutedColorMapping} />
      <View style={styles.rowContent}>
        <Text style={styles.rowCommand} numberOfLines={1}>
          {truncateCommand(task.command)}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {formatElapsed(task.startedAt)}
          {task.exitCode != null ? ` · exit ${task.exitCode}` : ""}
        </Text>
      </View>
    </View>
  );
}

const STATUS_DOT_STYLES: Record<string, string> = {
  running: "#3b82f6",
  completed: "#22c55e",
  failed: "#ef4444",
  cancelled: "#6b7280",
};

function StatusDot({ status }: { status: string }): ReactElement {
  const dotStyle = useMemo(
    () => ({
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: STATUS_DOT_STYLES[status] ?? STATUS_DOT_STYLES.cancelled,
    }),
    [status],
  );
  return <View style={dotStyle} />;
}

const styles = StyleSheet.create((theme) => ({
  outer: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
  },
  surface: {
    alignSelf: "stretch",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius["2xl"],
    overflow: "hidden",
  },
  surfaceExpanded: {
    paddingBottom: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  headerCollapsed: {
    paddingBottom: theme.spacing[3],
  },
  headerDivider: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  scroll: {
    maxHeight: TASKS_LIST_MAX_HEIGHT,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
  },
  rowCommand: {
    fontSize: theme.fontSize.sm,
    fontFamily: "monospace",
    color: theme.colors.foreground,
  },
  rowMeta: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
}));
