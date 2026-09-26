import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";

import {
  freebuffAccountDelete,
  freebuffAccountRename,
  freebuffAccountsList,
  freebuffAccountSetDefault,
  freebuffSessionEnd,
} from "../shared/accounts";
import { freebuffStatus } from "../shared/status";
import { AccountCard } from "./account-card";
import { AddAccountSection } from "./add-account";
import { CliPreferencesSection } from "./cli-preferences";
import { removeAccountMessage } from "./account-format";
import { ConfirmModal } from "./confirm-modal";

const END_SESSION_MESSAGES = {
  ended: "Session ended. The next prompt opens a new session (5 Freebucks).",
  "no-session": "No active session to end.",
  unauthenticated: "This account is not logged in.",
  unknown: "Session state unknown; nothing was ended.",
} as const;

const DELETE_MESSAGES = {
  removed: "Account removed.",
  "not-removed": "The account could not be removed.",
} as const;

type EndSessionKey = keyof typeof END_SESSION_MESSAGES;
type DeleteKey = keyof typeof DELETE_MESSAGES;

interface PendingAction {
  kind: "end-session" | "delete";
  accountId: string;
}

/** Adapter/server model-catalog check, folded in from the old sidebar surface. */
function ModelsSection({ theme }: { theme: PluginSurfaceProps["theme"] }) {
  const readStatus = useRpc(freebuffStatus);
  const statusQuery = useQuery({
    queryKey: ["freebuff-status"],
    queryFn: () => readStatus({}),
  });
  const refreshModels = useCallback(() => void statusQuery.refetch(), [statusQuery]);
  const modelCheck = statusQuery.data?.modelCheck;
  const differences =
    (modelCheck?.missingInAdapter.length ?? 0) + (modelCheck?.missingOnServer.length ?? 0);
  const styles = useMemo(
    () => ({
      muted: { color: theme.colors.foregroundMuted },
    }),
    [theme],
  );
  return (
    <SettingsSection title="Models" info="Whether the adapter offers every priced model.">
      {statusQuery.isError ? <Text>{String(statusQuery.error)}</Text> : null}
      {modelCheck && !modelCheck.checked ? (
        <Text style={styles.muted}>Server unreachable; model check skipped.</Text>
      ) : null}
      {modelCheck?.checked && differences === 0 ? (
        <Text style={styles.muted}>Adapter models match the server.</Text>
      ) : null}
      {modelCheck?.missingInAdapter.map((id) => (
        <Text key={`new-${id}`}>{`New on server, not selectable yet: ${id}`}</Text>
      ))}
      {modelCheck?.missingOnServer.map((id) => (
        <Text key={`gone-${id}`}>{`No longer priced by server: ${id}`}</Text>
      ))}
      <SettingsAction label="Model check" actionLabel="Refresh" onPress={refreshModels} />
    </SettingsSection>
  );
}

/** Freebuff settings screen under Settings → Plugins → Freebuff. */
export function FreebuffSettings({ theme, layout }: PluginSurfaceProps) {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const listAccounts = useRpc(freebuffAccountsList);
  const endSession = useRpc(freebuffSessionEnd);
  const deleteAccount = useRpc(freebuffAccountDelete);
  const setDefault = useRpc(freebuffAccountSetDefault);
  const renameAccount = useRpc(freebuffAccountRename);
  const queryClient = useQueryClient();
  const toast = useToast();

  const accountsQuery = useQuery({
    queryKey: ["freebuff-accounts"],
    queryFn: async () => {
      const result = await listAccounts({});
      return result;
    },
  });

  const refreshAccounts = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["freebuff-accounts"] });
  }, [queryClient]);

  const requestEndSession = useCallback((accountId: string) => {
    setPendingAction({ kind: "end-session", accountId });
  }, []);
  const requestDelete = useCallback((accountId: string) => {
    setPendingAction({ kind: "delete", accountId });
  }, []);

  const endSessionMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const result = await endSession({ id: accountId });
      return result;
    },
    onSuccess: (result) => {
      const key: EndSessionKey = result.result;
      toast.show(END_SESSION_MESSAGES[key], {
        variant: key === "ended" ? "success" : "default",
      });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
    onSettled: () => {
      refreshAccounts();
      setPendingAction(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const result = await deleteAccount({ id: accountId });
      return result;
    },
    onSuccess: (result) => {
      const key: DeleteKey = result.removed ? "removed" : "not-removed";
      toast.show(DELETE_MESSAGES[key], {
        variant: result.removed ? "success" : "error",
      });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
    onSettled: () => {
      refreshAccounts();
      setPendingAction(null);
    },
  });

  const setDefaultMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const result = await setDefault({ id: accountId });
      return result;
    },
    onSuccess: (result) => {
      toast.show(`New sessions start on "${result.defaultAccountId}".`, { variant: "success" });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
    onSettled: () => {
      refreshAccounts();
    },
  });

  const renameMutation = useMutation({
    mutationFn: async ({ id, label }: { id: string; label: string }) => {
      const result = await renameAccount({ id, label });
      return result;
    },
    onSuccess: (result) => {
      toast.show(`Renamed to "${result.label}".`, { variant: "success" });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
    onSettled: () => {
      refreshAccounts();
    },
  });

  const accounts = useMemo(() => accountsQuery.data?.accounts ?? [], [accountsQuery.data]);
  const styles = useMemo(
    () => ({
      muted: { color: theme.colors.foregroundMuted },
    }),
    [theme],
  );
  const refresh = useCallback(() => void accountsQuery.refetch(), [accountsQuery]);
  const closeAction = useCallback(() => setPendingAction(null), []);
  const handleConfirm = useCallback(() => {
    if (!pendingAction) return;
    if (pendingAction.kind === "end-session") {
      endSessionMutation.mutate(pendingAction.accountId);
    } else {
      deleteMutation.mutate(pendingAction.accountId);
    }
  }, [pendingAction, endSessionMutation, deleteMutation]);

  const handleRename = useCallback(
    (accountId: string, label: string) => {
      renameMutation.mutate({ id: accountId, label });
    },
    [renameMutation],
  );
  const handleSetDefault = useCallback(
    (accountId: string) => {
      setDefaultMutation.mutate(accountId);
    },
    [setDefaultMutation],
  );

  const pendingAccount = pendingAction
    ? accounts.find((account) => account.id === pendingAction.accountId)
    : undefined;
  const pendingIsEndSession = pendingAction?.kind === "end-session";

  return (
    <>
      <SettingsSection title="Accounts" info="Freebuff accounts registered on this host.">
        {accountsQuery.isPending ? <Text style={styles.muted}>Loading accounts…</Text> : null}
        {accountsQuery.isError ? (
          <Text accessibilityRole="alert">{accountsQuery.error.message}</Text>
        ) : null}
        {!accountsQuery.isPending && accounts.length === 0 ? (
          <Text style={styles.muted}>No accounts registered.</Text>
        ) : null}
        {accounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            theme={theme}
            compact={layout.compact}
            endSessionBusy={endSessionMutation.isPending && pendingAction?.accountId === account.id}
            deleteBusy={deleteMutation.isPending && pendingAction?.accountId === account.id}
            setDefaultBusy={setDefaultMutation.isPending}
            renameBusy={renameMutation.isPending}
            onEndSession={requestEndSession}
            onDelete={requestDelete}
            onSetDefault={handleSetDefault}
            onRename={handleRename}
          />
        ))}
        <SettingsAction label="Accounts" actionLabel="Refresh" onPress={refresh} />
      </SettingsSection>
      <AddAccountSection theme={theme} />
      <CliPreferencesSection accounts={accounts} />
      <ModelsSection theme={theme} />
      <ConfirmModal
        title={pendingIsEndSession ? "End session" : "Remove account"}
        message={
          pendingIsEndSession
            ? "This frees the account's Freebuff seat and can cut a run in progress. The next prompt opens a new session (5 Freebucks)."
            : removeAccountMessage(pendingAccount?.managed ?? false)
        }
        open={pendingAction != null}
        confirmLabel={pendingIsEndSession ? "End session" : "Remove"}
        busyLabel={pendingIsEndSession ? "Ending…" : "Removing…"}
        busy={endSessionMutation.isPending || deleteMutation.isPending}
        theme={theme}
        onConfirm={handleConfirm}
        onCancel={closeAction}
      />
    </>
  );
}
