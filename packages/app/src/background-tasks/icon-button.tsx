import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SquareTerminal } from "lucide-react-native";
import type { BackgroundTaskDescriptorPayload } from "@getpaseo/protocol/messages";

const ThemedSquareTerminal = withUnistyles(SquareTerminal);

const foregroundMutedColorMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

const STATUS_DOT_COLORS: Record<string, string> = {
  running: "#3b82f6",
  completed: "#22c55e",
  failed: "#ef4444",
  cancelled: "#6b7280",
};

function truncateCommand(command: string | null, maxLen = 40): string {
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

interface BackgroundTasksIconButtonProps {
  tasks: BackgroundTaskDescriptorPayload[];
}

export function BackgroundTasksIconButton({ tasks }: BackgroundTasksIconButtonProps): ReactElement {
  const [expanded, setExpanded] = useState(false);

  const runningCount = useMemo(() => tasks.filter((t) => t.status === "running").length, [tasks]);

  const hasTasks = tasks.length > 0;

  const badgeColor = useMemo(() => {
    if (runningCount > 0) return STATUS_DOT_COLORS.running;
    const failed = tasks.some((t) => t.status === "failed");
    if (failed) return STATUS_DOT_COLORS.failed;
    return STATUS_DOT_COLORS.completed;
  }, [runningCount, tasks]);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Background tasks: ${tasks.length} total, ${runningCount} running`}
        testID="background-tasks-icon-button"
        onPress={toggleExpanded}
        style={styles.iconButton}
      >
        <ThemedSquareTerminal size={14} uniProps={foregroundMutedColorMapping} />
        {hasTasks ? (
          <View style={[styles.badge, { backgroundColor: badgeColor }]}>
            <Text style={styles.badgeText}>{tasks.length > 9 ? "9+" : tasks.length}</Text>
          </View>
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.dropdown}>
          <View style={styles.dropdownHeader}>
            <Text style={styles.dropdownTitle}>Background Tasks</Text>
          </View>
          {tasks.length === 0 ? (
            <Text style={styles.emptyText}>No background tasks</Text>
          ) : (
            <ScrollView
              style={styles.dropdownScroll}
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}
            >
              {tasks.map((task) => (
                <View key={task.id} style={styles.dropdownRow}>
                  <View
                    style={[
                      styles.statusDot,
                      {
                        backgroundColor:
                          STATUS_DOT_COLORS[task.status] ?? STATUS_DOT_COLORS.cancelled,
                      },
                    ]}
                  />
                  <View style={styles.dropdownRowContent}>
                    <Text style={styles.dropdownRowCommand} numberOfLines={1}>
                      {truncateCommand(task.command)}
                    </Text>
                    <Text style={styles.dropdownRowMeta} numberOfLines={1}>
                      {formatElapsed(task.startedAt)}
                      {task.exitCode != null ? ` · exit ${task.exitCode}` : ""}
                    </Text>
                  </View>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "relative",
  },
  iconButton: {
    position: "relative",
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: -2,
    right: -4,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  badgeText: {
    fontSize: 8,
    fontWeight: "700",
    color: "#fff",
  },
  dropdown: {
    position: "absolute",
    bottom: 36,
    right: 0,
    width: 300,
    maxHeight: 240,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    zIndex: 100,
    overflow: "hidden",
  },
  dropdownHeader: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  dropdownTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  dropdownScroll: {
    maxHeight: 200,
  },
  emptyText: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  dropdownRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    flexShrink: 0,
  },
  dropdownRowContent: {
    flex: 1,
    minWidth: 0,
  },
  dropdownRowCommand: {
    fontSize: theme.fontSize.sm,
    fontFamily: "monospace",
    color: theme.colors.foreground,
  },
  dropdownRowMeta: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
  },
}));
