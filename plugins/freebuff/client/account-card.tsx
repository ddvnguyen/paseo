import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";

import { quotaLine, seatLine, walletLine, type AccountDetail } from "./account-format";

interface AccountCardProps {
  account: AccountDetail;
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
  endSessionBusy: boolean;
  deleteBusy: boolean;
  onEndSession(accountId: string): void;
  onDelete(accountId: string): void;
}

/** One settings card per Freebuff account: identity, quota, seat, and actions. */
export function AccountCard({
  account,
  theme,
  compact,
  endSessionBusy,
  deleteBusy,
  onEndSession,
  onDelete,
}: AccountCardProps) {
  const styles = useMemo(
    () => ({
      lines: { gap: compact ? 2 : 4 },
      muted: { color: theme.colors.foregroundMuted },
    }),
    [theme, compact],
  );
  const canEndSession = account.seat.state === "active";
  const handleEndSession = useCallback(() => onEndSession(account.id), [onEndSession, account.id]);
  const handleDelete = useCallback(() => onDelete(account.id), [onDelete, account.id]);
  return (
    <SettingsCard testID={`freebuff-account-${account.id}`}>
      <SettingsRow label={account.label} hint={account.isDefault ? "Default" : undefined}>
        <View style={styles.lines}>
          {!account.authenticated ? <Text style={styles.muted}>Not logged in</Text> : null}
          <Text style={styles.muted}>{`${quotaLine(account)}${walletLine(account)}`}</Text>
          <Text style={styles.muted}>{seatLine(account)}</Text>
        </View>
      </SettingsRow>
      {canEndSession ? (
        <SettingsAction
          label="Session"
          actionLabel="End session"
          disabled={endSessionBusy}
          onPress={handleEndSession}
        />
      ) : null}
      {!account.isDefault ? (
        <SettingsAction
          label="Remove this account"
          actionLabel="Remove"
          disabled={deleteBusy}
          onPress={handleDelete}
        />
      ) : null}
    </SettingsCard>
  );
}
