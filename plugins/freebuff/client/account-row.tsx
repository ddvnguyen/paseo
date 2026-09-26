import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsCard,
  SettingsIconButton,
  SettingsIconRow,
  SettingsInput,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";

import {
  ACCOUNT_LABEL_MAX_LENGTH,
  cliValue,
  identityLine,
  quotaSummaryLine,
  quotaUsedPercent,
  reasoningLine,
  seatLine,
  type AccountDetail,
  type CliSettings,
} from "./account-format";

interface AccountRowProps {
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
  /** Owner directive 2026-09-26: reorder — move this account up in the list. */
  onMoveUp(accountId: string): void;
  /** Whether this account is first in the rendered list (up arrow hidden). */
  canMoveUp: boolean;
}

const READ_ONLY_NOTE =
  "Read-only. Paseo agents take model and mode from the agent's own settings; these are the Freebuff CLI's saved preferences.";

/** One account's saved Freebuff CLI preferences as text rows. */
function CliPrefsBody({
  cli,
  theme,
}: {
  cli: CliSettings | null;
  theme: PluginSurfaceProps["theme"];
}) {
  const styles = useMemo(() => ({ muted: { color: theme.colors.foregroundMuted } }), [theme]);
  const effort = reasoningLine(cli?.freebuffReasoningEfforts, cli?.freebuffModel);
  if (cli == null) return <Text style={styles.muted}>No CLI settings found</Text>;
  return (
    <>
      <Text style={styles.muted}>{`Mode: ${cliValue(cli.mode)}`}</Text>
      <Text style={styles.muted}>{`Model: ${cliValue(cli.freebuffModel)}`}</Text>
      <Text style={styles.muted}>{`Ads: ${cliValue(cli.adsEnabled)}`}</Text>
      <Text style={styles.muted}>{`Reasoning per model: ${effort ?? "not set"}`}</Text>
      <Text style={styles.muted}>{READ_ONLY_NOTE}</Text>
    </>
  );
}

/**
 * Single-line quota summary (owner directive 2026-09-26) with the used-bar
 * when the numbers are known:
 * '100% used · 0/25 daily · Resets Sep 27, 12:00 AM'.
 */
function QuotaBlock({
  account,
  theme,
  compact,
}: {
  account: AccountDetail;
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
}) {
  const percent = quotaUsedPercent(account);
  const styles = useMemo(
    () => ({
      lines: { gap: compact ? 2 : 4 },
      muted: { color: theme.colors.foregroundMuted },
      barTrack: {
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.border,
      },
      barFill: {
        height: 4,
        borderRadius: 2,
        width: `${percent ?? 0}%`,
        backgroundColor: theme.colors.accent,
      },
    }),
    [theme, compact, percent],
  );
  return (
    <View style={styles.lines}>
      <Text style={styles.muted}>{quotaSummaryLine(account)}</Text>
      {percent != null ? (
        <View style={styles.barTrack}>
          <View style={styles.barFill} />
        </View>
      ) : null}
      <Text style={styles.muted}>{seatLine(account)}</Text>
    </View>
  );
}

/** Inline rename editor: input plus confirm/cancel icon buttons. */
function RenameEditor({
  initialLabel,
  renameBusy,
  onSave,
  onCancel,
}: {
  initialLabel: string;
  renameBusy: boolean;
  onSave(label: string): void;
  onCancel(): void;
}) {
  const [draftLabel, setDraftLabel] = useState(initialLabel);
  const labelError = useMemo(() => {
    if (draftLabel.length > ACCOUNT_LABEL_MAX_LENGTH) {
      return `Keep the label to ${ACCOUNT_LABEL_MAX_LENGTH} characters or fewer.`;
    }
    return null;
  }, [draftLabel]);
  const handleSave = useCallback(() => {
    if (labelError) return;
    onSave(draftLabel);
  }, [draftLabel, labelError, onSave]);
  const styles = useMemo(
    () => ({
      row: { flexDirection: "row", alignItems: "center", gap: 8 },
      inputFlex: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
    }),
    [],
  );
  return (
    <View style={styles.row}>
      <View style={styles.inputFlex}>
        <SettingsInput
          label="New label"
          initialValue={initialLabel}
          placeholder="Work laptop"
          onChangeText={setDraftLabel}
          error={labelError}
        />
      </View>
      <SettingsIconButton
        icon="Check"
        accessibilityLabel="Save label"
        disabled={renameBusy || labelError != null}
        onPress={handleSave}
        testID="freebuff-rename-save"
      />
      <SettingsIconButton
        icon="X"
        accessibilityLabel="Cancel rename"
        onPress={onCancel}
        testID="freebuff-rename-cancel"
      />
    </View>
  );
}

/** One settings row per Freebuff account: identity, quota, seat, and actions. */
export function AccountRow({
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
  onMoveUp,
  canMoveUp,
}: AccountRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const styles = useMemo(
    () => ({
      muted: { color: theme.colors.foregroundMuted },
      menuRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" as const },
      // Owner directive: delete bottom-right — name-line actions left, trash right.
      actionLine: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      actionLineSpacer: { flexGrow: 1 },
      prefsToggle: { flexDirection: "row", alignItems: "center", gap: 8 },
    }),
    [theme],
  );
  const identity = identityLine(account);
  const hint = identity || (account.isDefault ? "Default" : undefined);
  const startRename = useCallback(() => setRenaming(true), []);
  const cancelRename = useCallback(() => setRenaming(false), []);
  const handleRename = useCallback(
    (label: string) => {
      onRename(account.id, label);
      setRenaming(false);
    },
    [account.id, onRename],
  );
  const toggleMenu = useCallback(() => setMenuOpen((open) => !open), []);
  const togglePrefs = useCallback(() => setPrefsOpen((open) => !open), []);
  const handleMoveUp = useCallback(() => onMoveUp(account.id), [onMoveUp, account.id]);
  const handleSetDefault = useCallback(
    (value: boolean) => {
      if (value) onSetDefault(account.id);
    },
    [onSetDefault, account.id],
  );
  const handleEndSession = useCallback(() => onEndSession(account.id), [onEndSession, account.id]);
  const handleDelete = useCallback(() => onDelete(account.id), [onDelete, account.id]);

  const nameLineActions = (
    <>
      {canMoveUp ? (
        <SettingsIconButton
          icon="ChevronUp"
          accessibilityLabel={`Move ${account.label} up`}
          onPress={handleMoveUp}
          testID={`freebuff-move-up-${account.id}`}
        />
      ) : null}
      {!renaming ? (
        <SettingsIconButton
          icon="Pencil"
          accessibilityLabel={`Rename ${account.label}`}
          onPress={startRename}
          testID={`freebuff-rename-${account.id}`}
        />
      ) : null}
      <SettingsSwitch
        label="Default"
        value={account.isDefault}
        disabled={account.isDefault || setDefaultBusy}
        onValueChange={handleSetDefault}
        testID={`freebuff-default-${account.id}`}
      />
    </>
  );

  const bottomLineActions = (
    <>
      {account.seat.state === "active" ? (
        <SettingsIconButton
          icon="Power"
          accessibilityLabel={`End session for ${account.label}`}
          disabled={endSessionBusy}
          onPress={handleEndSession}
          testID={`freebuff-end-session-${account.id}`}
        />
      ) : null}
      {!account.isDefault ? (
        <SettingsIconButton
          icon="Trash2"
          accessibilityLabel={`Remove ${account.label}`}
          destructive
          disabled={deleteBusy}
          onPress={handleDelete}
          testID={`freebuff-remove-${account.id}`}
        />
      ) : null}
    </>
  );

  const menuButton = (
    <SettingsIconButton
      icon="MoreHorizontal"
      accessibilityLabel={`Actions for ${account.label}`}
      onPress={toggleMenu}
      testID={`freebuff-menu-${account.id}`}
    />
  );

  return (
    <SettingsCard testID={`freebuff-account-${account.id}`}>
      <SettingsIconRow
        icon="User"
        label={renaming ? "Rename account" : account.label}
        hint={hint}
        testID={`freebuff-account-row-${account.id}`}
        // Pencil + Default switch end the name line, vertically centered (wide).
        trailing={compact ? menuButton : nameLineActions}
      >
        <QuotaBlock account={account} theme={theme} compact={compact} />
        {renaming ? (
          <RenameEditor
            initialLabel={account.label}
            renameBusy={renameBusy}
            onSave={handleRename}
            onCancel={cancelRename}
          />
        ) : null}
        {compact && menuOpen ? (
          <View style={styles.menuRow} testID={`freebuff-menu-open-${account.id}`}>
            {nameLineActions}
            {bottomLineActions}
          </View>
        ) : null}
        {!compact ? (
          // Delete (and end-session) bottom-right, under the quota/seat lines.
          <View style={styles.actionLine} testID={`freebuff-bottom-actions-${account.id}`}>
            <View style={styles.actionLineSpacer} />
            {bottomLineActions}
          </View>
        ) : null}
        <View style={styles.prefsToggle}>
          <SettingsIconButton
            icon={prefsOpen ? "ChevronDown" : "ChevronRight"}
            accessibilityLabel={prefsOpen ? "Hide CLI preferences" : "Show CLI preferences"}
            onPress={togglePrefs}
            testID={`freebuff-prefs-${account.id}`}
          />
          <Text style={styles.muted}>CLI preferences</Text>
        </View>
        {prefsOpen ? <CliPrefsBody cli={account.cliSettings} theme={theme} /> : null}
      </SettingsIconRow>
    </SettingsCard>
  );
}
