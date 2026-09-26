import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";

import {
  ACCOUNT_LABEL_MAX_LENGTH,
  quotaLine,
  seatLine,
  walletLine,
  type AccountDetail,
} from "./account-format";

interface AccountCardProps {
  account: AccountDetail;
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
  endSessionBusy: boolean;
  deleteBusy: boolean;
  setDefaultBusy: boolean;
  renameBusy: boolean;
  onEndSession(accountId: string): void;
  onDelete(accountId: string): void;
  onSetDefault(accountId: string): void;
  onRename(accountId: string, label: string): void;
}

/** One settings card per Freebuff account: identity, quota, seat, and actions. */
export function AccountCard({
  account,
  theme,
  compact,
  endSessionBusy,
  deleteBusy,
  setDefaultBusy,
  renameBusy,
  onEndSession,
  onDelete,
  onSetDefault,
  onRename,
}: AccountCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
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
  const handleSetDefault = useCallback(() => onSetDefault(account.id), [onSetDefault, account.id]);
  const startRename = useCallback(() => {
    setDraftLabel(account.label);
    setRenaming(true);
  }, [account.label]);
  const cancelRename = useCallback(() => setRenaming(false), []);
  const labelError = useMemo(() => {
    if (draftLabel.length > ACCOUNT_LABEL_MAX_LENGTH) {
      return `Keep the label to ${ACCOUNT_LABEL_MAX_LENGTH} characters or fewer.`;
    }
    return null;
  }, [draftLabel]);
  const handleRename = useCallback(() => {
    if (labelError) return;
    onRename(account.id, draftLabel);
    setRenaming(false);
  }, [draftLabel, labelError, onRename, account.id]);
  return (
    <SettingsCard testID={`freebuff-account-${account.id}`}>
      <SettingsRow
        label={account.label}
        hint={account.isDefault ? "Default" : undefined}
        error={renaming ? labelError : null}
      >
        <View style={styles.lines}>
          {!account.authenticated ? <Text style={styles.muted}>Not logged in</Text> : null}
          <Text style={styles.muted}>{`${quotaLine(account)}${walletLine(account)}`}</Text>
          <Text style={styles.muted}>{seatLine(account)}</Text>
        </View>
      </SettingsRow>
      {renaming ? (
        <>
          <SettingsInput
            label="New label"
            initialValue={account.label}
            placeholder="Work laptop"
            onChangeText={setDraftLabel}
            error={labelError}
          />
          <SettingsAction
            label="Rename"
            actionLabel="Save"
            disabled={renameBusy || labelError != null}
            onPress={handleRename}
          />
          <SettingsAction label="Rename" actionLabel="Cancel" onPress={cancelRename} />
        </>
      ) : (
        <SettingsAction label="Rename" actionLabel="Rename" onPress={startRename} />
      )}
      {!account.isDefault ? (
        <SettingsAction
          label="Make default"
          actionLabel="Make default"
          disabled={setDefaultBusy}
          onPress={handleSetDefault}
        />
      ) : null}
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
