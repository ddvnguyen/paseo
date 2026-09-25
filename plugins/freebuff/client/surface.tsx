import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { freebuffStatus } from "../shared/status";

function quotaLine(account: {
  authenticated: boolean;
  status: { dailyRemaining?: number; dailyLimit?: number } | null;
}): string {
  if (!account.authenticated) return "Not logged in";
  if (account.status?.dailyRemaining == null) return "Quota unavailable";
  return `${account.status.dailyRemaining}/${account.status.dailyLimit ?? "?"} Freebucks left today`;
}

export function FreebuffSurface({ theme, layout }: PluginSurfaceProps) {
  const readStatus = useRpc(freebuffStatus);
  const query = useQuery({ queryKey: ["freebuff-status"], queryFn: () => readStatus({}) });
  const styles = useMemo(
    () => ({
      scroll: { flex: 1, backgroundColor: theme.colors.surface0 },
      screen: {
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 12 : 16,
        backgroundColor: theme.colors.surface0,
      },
      heading: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 20 },
      label: { color: theme.colors.foregroundMuted },
      value: { color: theme.colors.foreground },
      card: {
        padding: 12,
        gap: 4,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
      },
      button: { padding: 12, borderRadius: 10, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.accentForeground, textAlign: "center" as const },
    }),
    [theme, layout.compact],
  );
  const { refetch } = query;
  const refresh = useCallback(() => void refetch(), [refetch]);
  const report = query.data;
  return (
    <ScrollView style={styles.scroll}>
      <View style={styles.screen}>
        <Text style={styles.heading}>Accounts</Text>
        {query.isPending ? <Text style={styles.label}>Loading…</Text> : null}
        {query.isError ? <Text style={styles.value}>{String(query.error)}</Text> : null}
        {report?.accounts.map((account) => (
          <View key={account.id} style={styles.card}>
            <Text style={styles.value}>{account.label}</Text>
            <Text style={styles.label}>{quotaLine(account)}</Text>
          </View>
        ))}
        <Text style={styles.heading}>Models</Text>
        {report && !report.modelCheck.checked ? (
          <Text style={styles.label}>Server unreachable; model check skipped.</Text>
        ) : null}
        {report?.modelCheck.checked &&
        report.modelCheck.missingInAdapter.length + report.modelCheck.missingOnServer.length ===
          0 ? (
          <Text style={styles.label}>Adapter models match the server.</Text>
        ) : null}
        {report?.modelCheck.missingInAdapter.map((id) => (
          <Text key={`new-${id}`} style={styles.value}>
            {`New on server, not selectable yet: ${id}`}
          </Text>
        ))}
        {report?.modelCheck.missingOnServer.map((id) => (
          <Text key={`gone-${id}`} style={styles.value}>
            {`No longer priced by server: ${id}`}
          </Text>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh Freebuff status"
          onPress={refresh}
          style={styles.button}
        >
          <Text style={styles.buttonText}>Refresh</Text>
        </Pressable>
        <Text style={styles.label}>Accounts are managed in Settings → Plugins → Freebuff</Text>
      </View>
    </ScrollView>
  );
}
