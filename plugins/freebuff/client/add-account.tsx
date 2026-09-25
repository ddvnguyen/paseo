import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import {
  ExternalLink,
  SettingsAction,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";

import { freebuffLoginCancel, freebuffLoginPoll, freebuffLoginStart } from "../shared/accounts";
import { isValidAccountId, validateAccountId } from "./account-format";

const POLL_INTERVAL_MS = 5000;

interface AddAccountProps {
  theme: PluginSurfaceProps["theme"];
  existingIds: readonly string[];
}

type Phase = "form" | "login";

interface LoginPanelProps {
  theme: PluginSurfaceProps["theme"];
  loginId: string;
  loginUrl: string;
  attempt: number;
  onGetNewLink(): void;
  onStartOver(): void;
}

type PollStatus = "pending" | "expired" | "success" | "none" | "error";

/** Browser login panel: link, copy, open, poll outcome, and cancel. */
function LoginPanel({
  theme,
  loginId,
  loginUrl,
  attempt,
  onGetNewLink,
  onStartOver,
}: LoginPanelProps) {
  const pollLogin = useRpc(freebuffLoginPoll);
  const cancelLogin = useRpc(freebuffLoginCancel);
  const toast = useToast();
  const queryClient = useQueryClient();
  const successHandledRef = useRef(false);

  // A terminal result must stick: after success the adapter deletes the pending
  // file, so any further poll (window focus, remount) would answer `none` and
  // replace "Logged in as…" with "Login was cancelled".
  const [settledStatus, setSettledStatus] = useState<PollStatus | null>(null);
  const pollQuery = useQuery({
    queryKey: ["freebuff-login-poll", loginId, attempt],
    queryFn: async () => {
      const result = await pollLogin({ id: loginId });
      return result;
    },
    enabled: loginId.length > 0 && settledStatus === null,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status == null ? POLL_INTERVAL_MS : false;
    },
  });
  const pollRefetch = pollQuery.refetch;

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const result = await cancelLogin({ id: loginId });
      return result;
    },
    onSuccess: () => {
      setSettledStatus(null);
      void pollRefetch();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const pollData = pollQuery.data;
  const pollStatus: PollStatus | undefined = pollData?.status;

  useEffect(() => {
    if (pollStatus !== undefined && pollStatus !== "pending") setSettledStatus(pollStatus);
  }, [pollStatus]);

  const refreshAccounts = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["freebuff-accounts"] });
  }, [queryClient]);

  useEffect(() => {
    if (pollStatus !== "success" || successHandledRef.current) return;
    successHandledRef.current = true;
    refreshAccounts();
  }, [pollStatus, refreshAccounts]);

  const copyLink = useCallback(async () => {
    try {
      await copyText(loginUrl);
      toast.show("Link copied", { variant: "success" });
    } catch {
      toast.error("Could not copy. Select the link text and use Copy.");
    }
  }, [loginUrl, toast]);

  const styles = useMemo(
    () => ({
      stack: { gap: 4 },
      muted: { color: theme.colors.foregroundMuted },
      foreground: { color: theme.colors.foreground },
      success: { color: theme.colors.statusSuccess },
    }),
    [theme],
  );

  return (
    <SettingsSection title="Log in with Freebuff">
      <View style={styles.stack}>
        <Text selectable style={styles.foreground}>
          {loginUrl}
        </Text>
        <Text style={styles.muted}>
          Open the link in a browser and approve the login, then wait here.
        </Text>
      </View>
      <SettingsAction label="Login link" actionLabel="Copy link" onPress={copyLink} />
      <ExternalLink href={loginUrl} accessibilityLabel="Open the Freebuff login page">
        Open in browser
      </ExternalLink>
      {pollStatus === "success" ? (
        <Text style={styles.success}>
          {`✓ Logged in as ${pollData?.name ?? "unknown"} (${pollData?.email ?? "unknown"})`}
        </Text>
      ) : (
        <Text style={styles.muted}>Waiting for you to log in in the browser…</Text>
      )}
      {pollStatus === "pending" && pollData?.httpStatus != null ? (
        <Text style={styles.muted}>
          {`Freebuff server answered HTTP ${pollData.httpStatus}; still waiting`}
        </Text>
      ) : null}
      {pollQuery.isError ? <Text accessibilityRole="alert">{pollQuery.error.message}</Text> : null}
      {pollStatus === "expired" ? (
        <View style={styles.stack}>
          <Text style={styles.muted}>This link expired.</Text>
          <SettingsAction
            label="Expired link"
            actionLabel="Get a new link"
            onPress={onGetNewLink}
          />
        </View>
      ) : null}
      {pollStatus === "error" ? (
        <Text style={styles.muted}>{pollData?.reason ?? "Login failed."}</Text>
      ) : null}
      {pollStatus === "none" ? (
        <View style={styles.stack}>
          <Text style={styles.muted}>Login was cancelled.</Text>
          <SettingsAction
            label="Cancelled login"
            actionLabel="Add another account"
            onPress={onStartOver}
          />
        </View>
      ) : null}
      {pollStatus === "success" ? (
        <SettingsAction label="Done" actionLabel="Add another account" onPress={onStartOver} />
      ) : (
        <SettingsAction
          label="Waiting"
          actionLabel="Cancel"
          disabled={cancelMutation.isPending}
          onPress={cancelMutation.mutate}
        />
      )}
    </SettingsSection>
  );
}

/**
 * 'Add account' section: id/label form, then the browser login panel that
 * polls freebuff.login.poll until the login succeeds, expires, or is cancelled.
 */
export function AddAccountSection({ theme, existingIds }: AddAccountProps) {
  const [accountId, setAccountId] = useState("");
  const [label, setLabel] = useState("");
  const [touched, setTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [loginId, setLoginId] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [attempt, setAttempt] = useState(0);
  const toast = useToast();
  const startLogin = useRpc(freebuffLoginStart);

  const idError = useMemo(
    () => (touched ? validateAccountId(accountId, existingIds) : ""),
    [touched, accountId, existingIds],
  );

  const startMutation = useMutation({
    mutationFn: async () => {
      const result = await startLogin({
        id: accountId,
        label: label.length > 0 ? label : undefined,
      });
      return result;
    },
    onSuccess: (result) => {
      setLoginId(accountId);
      setLoginUrl(result.loginUrl);
      setAttempt((current) => current + 1);
      setPhase("login");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const clearForm = useCallback(() => {
    setAccountId("");
    setLabel("");
    setTouched(false);
    setPhase("form");
  }, []);

  const resetToForm = useCallback(() => {
    clearForm();
    setLoginId("");
    setLoginUrl("");
  }, [clearForm]);

  const handleIdChange = useCallback((text: string) => {
    setTouched(true);
    setAccountId(text.trim());
  }, []);
  const handleLabelChange = useCallback((text: string) => setLabel(text), []);
  const handleStart = useCallback(() => {
    setTouched(true);
    if (!isValidAccountId(accountId, existingIds)) return;
    startMutation.mutate();
  }, [accountId, existingIds, startMutation]);

  const startMutate = startMutation.mutate;
  const handleGetNewLink = useCallback(() => {
    startMutate();
  }, [startMutate]);

  const styles = useMemo(
    () => ({
      muted: { color: theme.colors.foregroundMuted },
    }),
    [theme],
  );

  if (phase === "login") {
    return (
      <LoginPanel
        theme={theme}
        loginId={loginId}
        loginUrl={loginUrl}
        attempt={attempt}
        onGetNewLink={handleGetNewLink}
        onStartOver={resetToForm}
      />
    );
  }

  return (
    <SettingsSection title="Add account">
      <SettingsInput
        label="Account id"
        placeholder="work-laptop"
        onChangeText={handleIdChange}
        error={idError.length > 0 ? idError : null}
      />
      <SettingsInput
        label="Label (optional)"
        placeholder="Work laptop"
        onChangeText={handleLabelChange}
      />
      <SettingsAction
        label="Browser login"
        actionLabel="Log in with Freebuff"
        disabled={startMutation.isPending}
        onPress={handleStart}
      />
      {startMutation.isError ? (
        <Text accessibilityRole="alert" style={styles.muted}>
          {startMutation.error.message}
        </Text>
      ) : null}
    </SettingsSection>
  );
}
