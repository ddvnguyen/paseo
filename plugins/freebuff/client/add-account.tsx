import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import {
  ExternalLink,
  SettingsAction,
  SettingsCard,
  SettingsIconButton,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";

import { freebuffLoginCancel, freebuffLoginPoll, freebuffLoginStart } from "../shared/accounts";

const POLL_INTERVAL_MS = 5000;

interface AddAccountProps {
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
}

type Phase = "form" | "login";

interface LoginPanelProps {
  theme: PluginSurfaceProps["theme"];
  compact: boolean;
  loginId: string;
  loginUrl: string;
  attempt: number;
  onGetNewLink(): void;
  onStartOver(): void;
}

type PollStatus = "pending" | "expired" | "success" | "none" | "error";
type LoginPollResult = RpcOutput<typeof freebuffLoginPoll>;

interface LoginOutcomeProps {
  theme: PluginSurfaceProps["theme"];
  pollData: LoginPollResult | undefined;
  onGetNewLink(): void;
  onStartOver(): void;
}

/** Terminal poll outcomes: logged in, expired link, failure, or cancelled. */
function LoginOutcome({ theme, pollData, onGetNewLink, onStartOver }: LoginOutcomeProps) {
  const pollStatus = pollData?.status;
  const styles = useMemo(
    () => ({
      stack: { gap: 4 },
      muted: { color: theme.colors.foregroundMuted },
      success: { color: theme.colors.statusSuccess },
    }),
    [theme],
  );
  return (
    <>
      {pollStatus === "success" ? (
        <Text style={styles.success}>
          {`✓ Logged in as ${pollData?.name ?? "unknown"} (${pollData?.email ?? "unknown"})`}
        </Text>
      ) : null}
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
      ) : null}
    </>
  );
}

/** Browser login card: link, copy, open, poll outcome, and cancel. */
function LoginPanel({
  theme,
  compact,
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
  // Waiting until the poll reports a terminal outcome; hides the wait text and
  // Cancel once the login succeeded, expired, failed, or was cancelled.
  const waiting = pollStatus === undefined || pollStatus === "pending";

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
      linkRow: { flexDirection: "row", alignItems: "center", gap: 8 },
      muted: { color: theme.colors.foregroundMuted },
      foreground: { color: theme.colors.foreground },
      success: { color: theme.colors.statusSuccess },
    }),
    [theme],
  );
  const handleCancel = useCallback(() => {
    cancelMutation.mutate();
  }, [cancelMutation]);

  return (
    <SettingsCard testID="freebuff-login-panel">
      <Text selectable style={styles.foreground}>
        {loginUrl}
      </Text>
      <Text style={styles.muted}>
        Open the link in a browser and approve the login, then wait here.
      </Text>
      <View style={compact ? styles.stack : styles.linkRow}>
        <SettingsIconButton
          icon="Copy"
          accessibilityLabel="Copy login link"
          onPress={copyLink}
          testID="freebuff-login-copy"
        />
        <ExternalLink href={loginUrl} accessibilityLabel="Open the Freebuff login page">
          Open in browser
        </ExternalLink>
        {waiting ? (
          <SettingsIconButton
            icon="X"
            accessibilityLabel="Cancel login"
            disabled={cancelMutation.isPending}
            onPress={handleCancel}
            testID="freebuff-login-cancel"
          />
        ) : null}
      </View>
      {waiting ? <Text style={styles.muted}>Waiting for you to log in in the browser…</Text> : null}
      {pollStatus === "pending" && pollData?.httpStatus != null ? (
        <Text style={styles.muted}>
          {`Freebuff server answered HTTP ${pollData.httpStatus}; still waiting`}
        </Text>
      ) : null}
      {pollQuery.isError ? <Text accessibilityRole="alert">{pollQuery.error.message}</Text> : null}
      <LoginOutcome
        theme={theme}
        pollData={pollData}
        onGetNewLink={onGetNewLink}
        onStartOver={onStartOver}
      />
    </SettingsCard>
  );
}

/**
 * 'Add account' section: label form, then the browser login card that
 * polls freebuff.login.poll until the login succeeds, expires, or is cancelled.
 * The account id is never typed: the adapter mints a provisional handshake key
 * at start and registers the API-sourced id when the login succeeds.
 */
export function AddAccountSection({ theme, compact }: AddAccountProps) {
  const [label, setLabel] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [loginId, setLoginId] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [attempt, setAttempt] = useState(0);
  const toast = useToast();
  const startLogin = useRpc(freebuffLoginStart);

  const startMutation = useMutation({
    mutationFn: async () => {
      const result = await startLogin({
        label: label.length > 0 ? label : undefined,
      });
      return result;
    },
    onSuccess: (result) => {
      setLoginId(result.id);
      setLoginUrl(result.loginUrl);
      setAttempt((current) => current + 1);
      setPhase("login");
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const clearForm = useCallback(() => {
    setLabel("");
    setPhase("form");
  }, []);

  const resetToForm = useCallback(() => {
    clearForm();
    setLoginId("");
    setLoginUrl("");
  }, [clearForm]);

  const handleLabelChange = useCallback((text: string) => setLabel(text), []);
  const handleStart = useCallback(() => {
    startMutation.mutate();
  }, [startMutation]);

  const startMutate = startMutation.mutate;
  const handleGetNewLink = useCallback(() => {
    startMutate();
  }, [startMutate]);

  const styles = useMemo(
    () => ({
      stack: { gap: 4 },
      formRow: { flexDirection: "row", alignItems: "center", gap: 8 },
      formInput: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
      muted: { color: theme.colors.foregroundMuted },
    }),
    [theme],
  );

  if (phase === "login") {
    return (
      <SettingsSection title="Add account">
        <LoginPanel
          theme={theme}
          compact={compact}
          loginId={loginId}
          loginUrl={loginUrl}
          attempt={attempt}
          onGetNewLink={handleGetNewLink}
          onStartOver={resetToForm}
        />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Add account">
      <SettingsCard testID="freebuff-add-account">
        <View style={compact ? styles.stack : styles.formRow}>
          <View style={compact ? undefined : styles.formInput}>
            <SettingsInput
              label="Label (optional)"
              placeholder="Work laptop"
              onChangeText={handleLabelChange}
            />
          </View>
          <SettingsAction
            label="Browser login"
            actionLabel="Log in with Freebuff"
            disabled={startMutation.isPending}
            onPress={handleStart}
          />
        </View>
        {startMutation.isError ? (
          <Text accessibilityRole="alert" style={styles.muted}>
            {startMutation.error.message}
          </Text>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
