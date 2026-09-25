import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";

import { freebuffStatus } from "../shared/status";
import { FreebuffSettings } from "./settings-screen";

/**
 * Sidebar page. Accounts, login and CLI preferences are the settings screen
 * (Settings → Plugins → Freebuff); this page shows the same content so it is
 * one click from the sidebar, plus the model check.
 */
export function FreebuffSurface(props: PluginSurfaceProps) {
  const { theme, layout } = props;
  const readStatus = useRpc(freebuffStatus);
  const query = useQuery({ queryKey: ["freebuff-status"], queryFn: () => readStatus({}) });
  const { refetch } = query;
  const refresh = useCallback(() => void refetch(), [refetch]);
  const styles = useMemo(
    () => ({
      scroll: { flex: 1, backgroundColor: theme.colors.surface0 },
      screen: {
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 12 : 16,
        backgroundColor: theme.colors.surface0,
      },
      label: { color: theme.colors.foregroundMuted },
      value: { color: theme.colors.foreground },
    }),
    [theme, layout.compact],
  );
  const check = query.data?.modelCheck;
  const differences = (check?.missingInAdapter.length ?? 0) + (check?.missingOnServer.length ?? 0);
  return (
    <ScrollView style={styles.scroll}>
      <View style={styles.screen}>
        <FreebuffSettings {...props} />
        <SettingsSection title="Models">
          {query.isError ? <Text style={styles.value}>{String(query.error)}</Text> : null}
          {check && !check.checked ? (
            <Text style={styles.label}>Server unreachable; model check skipped.</Text>
          ) : null}
          {check?.checked && differences === 0 ? (
            <Text style={styles.label}>Adapter models match the server.</Text>
          ) : null}
          {check?.missingInAdapter.map((id) => (
            <Text key={`new-${id}`} style={styles.value}>
              {`New on server, not selectable yet: ${id}`}
            </Text>
          ))}
          {check?.missingOnServer.map((id) => (
            <Text key={`gone-${id}`} style={styles.value}>
              {`No longer priced by server: ${id}`}
            </Text>
          ))}
          <SettingsAction label="Model check" actionLabel="Refresh" onPress={refresh} />
        </SettingsSection>
      </View>
    </ScrollView>
  );
}
