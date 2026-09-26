import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";

import { cliValue, reasoningLine, type AccountDetail, type CliSettings } from "./account-format";

interface PrefRow {
  key: string;
  label: string;
  value: string;
}

const READ_ONLY_NOTE =
  "Read-only. Paseo agents take model and mode from the agent's own settings; these are the Freebuff CLI's saved preferences.";

/** Rows describing one account's saved Freebuff CLI preferences. */
function prefRows(cli: CliSettings): PrefRow[] {
  const effort = reasoningLine(cli.freebuffReasoningEfforts, cli.freebuffModel);
  return [
    { key: "mode", label: "Mode", value: cliValue(cli.mode) },
    { key: "model", label: "Model", value: cliValue(cli.freebuffModel) },
    { key: "ads", label: "Ads", value: cliValue(cli.adsEnabled) },
    { key: "reasoning", label: "Reasoning per model", value: effort ?? "not set" },
  ];
}

/** One account's read-only CLI preference rows. */
export function CliPreferences({ account }: { account: AccountDetail }) {
  const cli = account.cliSettings;
  const rows = useMemo(() => (cli == null ? [] : prefRows(cli)), [cli]);
  const heading = account.isDefault ? `${account.label} (Default)` : account.label;
  return (
    <SettingsCard>
      <SettingsRow label={heading} hint="Freebuff CLI preferences" />
      {cli == null ? (
        <SettingsRow label="No CLI settings found" />
      ) : (
        rows.map((row) => <SettingsRow key={row.key} label={row.label} hint={row.value} />)
      )}
    </SettingsCard>
  );
}

/** Section listing the Freebuff CLI's saved preferences for each account. */
export function CliPreferencesSection({ accounts }: { accounts: AccountDetail[] }) {
  return (
    <SettingsSection title="Freebuff CLI preferences">
      {accounts.map((account) => (
        <CliPreferences key={account.id} account={account} />
      ))}
      <SettingsRow label="Read-only" hint={READ_ONLY_NOTE} />
    </SettingsSection>
  );
}
