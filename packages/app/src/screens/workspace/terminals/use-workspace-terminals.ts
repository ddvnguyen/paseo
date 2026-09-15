import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import { resolveTerminalProfileLaunch } from "@getpaseo/protocol/terminal-profiles";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useTranslation } from "react-i18next";
import { useReplicaQuery } from "@/data/query";
import { workspaceTerminalsPushRoute } from "@/data/push-router";
import {
  buildTerminalsQueryKey,
  canCreateWorkspaceTerminal,
  collectKnownTerminalIds,
  collectScriptTerminalIds,
  collectStandaloneTerminalIds,
  reconcilePendingScriptTerminals,
  removeTerminalFromPayload,
  type ListTerminalsPayload,
  upsertCreatedTerminalPayload,
} from "@/screens/workspace/terminals/state";

export type TerminalTabDestination =
  | { kind: "open"; paneId?: string }
  | { kind: "replace"; tabId: string };

interface PendingTerminalCreateInput {
  destination: TerminalTabDestination;
  profile?: TerminalProfile;
}

interface UseWorkspaceTerminalsInput {
  client: DaemonClient | null;
  isConnected: boolean;
  isRouteFocused: boolean;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  workspaceDirectory: string | null;
  workspaceScripts: WorkspaceDescriptor["scripts"];
  hasHydratedWorkspaces: boolean;
  isMissingWorkspaceDirectory: boolean;
  onTerminalCreated: (input: { terminalId: string; destination: TerminalTabDestination }) => void;
  onScriptTerminalSelected: (terminalId: string) => void;
  onWorkspacePathUnavailable: () => void;
  onTerminalCreateQueued: () => void;
  onTerminalCreateFailed: (reason: string) => void;
}

export function useWorkspaceTerminals(input: UseWorkspaceTerminalsInput) {
  const {
    client,
    isConnected,
    isRouteFocused,
    normalizedServerId,
    normalizedWorkspaceId,
    workspaceDirectory,
    workspaceScripts,
    hasHydratedWorkspaces,
    isMissingWorkspaceDirectory,
    onTerminalCreated,
    onScriptTerminalSelected,
    onWorkspacePathUnavailable,
    onTerminalCreateQueued,
    onTerminalCreateFailed,
  } = input;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [pendingCreateInput, setPendingCreateInput] = useState<PendingTerminalCreateInput | null>(
    null,
  );
  // A create that failed while the socket looked connected usually means the
  // connection was already stale (idle cull, restart). Retrying immediately
  // would hit the same dead socket, so hold the input and replay it once the
  // client reports a fresh connection instead of leaving a dead terminal tab.
  const [failedCreateInput, setFailedCreateInput] = useState<PendingTerminalCreateInput | null>(
    null,
  );
  const canCreateNow = useMemo(
    () => canCreateWorkspaceTerminal({ isRouteFocused, client, isConnected, workspaceDirectory }),
    [isRouteFocused, client, isConnected, workspaceDirectory],
  );
  const queryKey = useMemo(
    () =>
      buildTerminalsQueryKey(normalizedServerId, workspaceDirectory, normalizedWorkspaceId || null),
    [normalizedServerId, normalizedWorkspaceId, workspaceDirectory],
  );
  const paneWorkspaceId = normalizedWorkspaceId || undefined;

  const query = useReplicaQuery({
    queryKey,
    enabled: canCreateNow,
    pushEvent: "terminals_changed",
    meta: workspaceTerminalsPushRoute({
      enabled: canCreateNow,
      serverId: normalizedServerId,
      cwd: workspaceDirectory ?? "",
      ...(paneWorkspaceId ? { workspaceId: paneWorkspaceId } : {}),
    }),
    queryFn: async () => {
      if (!client || !workspaceDirectory) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      if (paneWorkspaceId) {
        return await client.listTerminals(workspaceDirectory, undefined, {
          workspaceId: paneWorkspaceId,
        });
      }
      return await client.listTerminals(workspaceDirectory, undefined, {});
    },
  });
  const terminals = useMemo(() => query.data?.terminals ?? [], [query.data]);
  const liveTerminalIds = useMemo(() => terminals.map((terminal) => terminal.id), [terminals]);
  const [pendingScriptTerminalIds, setPendingScriptTerminalIds] = useState<Map<string, number>>(
    () => new Map(),
  );

  useEffect(() => {
    setPendingScriptTerminalIds(new Map());
  }, [normalizedServerId, normalizedWorkspaceId]);

  const dataUpdatedAt = query.dataUpdatedAt;
  useEffect(() => {
    setPendingScriptTerminalIds(reconcilePendingScriptTerminals(liveTerminalIds, dataUpdatedAt));
  }, [liveTerminalIds, dataUpdatedAt]);

  const knownTerminalIds = useMemo(
    () => collectKnownTerminalIds({ liveTerminalIds, pendingScriptTerminalIds }),
    [liveTerminalIds, pendingScriptTerminalIds],
  );
  const scriptTerminalIds = useMemo(
    () => collectScriptTerminalIds({ pendingScriptTerminalIds, scripts: workspaceScripts }),
    [pendingScriptTerminalIds, workspaceScripts],
  );
  const standaloneTerminalIds = useMemo(
    () => collectStandaloneTerminalIds({ terminals, scriptTerminalIds }),
    [scriptTerminalIds, terminals],
  );

  const createMutation = useMutation({
    mutationFn: async (_input: PendingTerminalCreateInput) => {
      if (!client || !workspaceDirectory) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const profile = _input.profile ? resolveTerminalProfileLaunch(_input.profile, "") : undefined;
      const payload = profile
        ? await client.createTerminal(workspaceDirectory, profile.name, undefined, {
            command: profile.command,
            args: profile.args,
            workspaceId: normalizedWorkspaceId || undefined,
          })
        : await client.createTerminal(workspaceDirectory, undefined, undefined, {
            workspaceId: normalizedWorkspaceId || undefined,
          });
      // The daemon reports a failed spawn (e.g. a profile command that isn't
      // installed) via payload.error with a null terminal. Surface it instead
      // of silently treating the create as a no-op success.
      if (!payload.terminal && payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
    onSuccess: (payload, createInput) => {
      const createdTerminal = payload.terminal;
      // Any successful create supersedes a held failure; without this a later
      // reconnect would spawn a surprise duplicate terminal.
      setFailedCreateInput(null);
      if (createdTerminal) {
        queryClient.setQueryData<ListTerminalsPayload>(queryKey, (current) =>
          upsertCreatedTerminalPayload({
            current,
            terminal: createdTerminal,
            workspaceDirectory,
          }),
        );
      }

      void queryClient.invalidateQueries({ queryKey });
      if (createdTerminal) {
        onTerminalCreated({
          terminalId: createdTerminal.id,
          destination: createInput.destination,
        });
      }
    },
    onError: (error: unknown, failedInput) => {
      setFailedCreateInput(failedInput);
      onTerminalCreateFailed(error instanceof Error ? error.message : String(error));
    },
  });
  const killMutation = useMutation({
    mutationFn: async (terminalId: string) => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.killTerminal(terminalId);
      if (!payload.success) {
        throw new Error("Unable to close terminal");
      }
      return payload;
    },
  });

  useEffect(() => {
    if (!pendingCreateInput) {
      return;
    }

    if (canCreateNow && !createMutation.isPending) {
      const pendingInput = pendingCreateInput;
      setPendingCreateInput(null);
      createMutation.mutate(pendingInput);
      return;
    }

    if (hasHydratedWorkspaces && isMissingWorkspaceDirectory) {
      setPendingCreateInput(null);
      onWorkspacePathUnavailable();
    }
  }, [
    canCreateNow,
    createMutation,
    hasHydratedWorkspaces,
    isMissingWorkspaceDirectory,
    onWorkspacePathUnavailable,
    pendingCreateInput,
  ]);

  const wasConnectedRef = useRef(isConnected);
  useEffect(() => {
    const wasConnected = wasConnectedRef.current;
    wasConnectedRef.current = isConnected;
    // Only a real disconnect→reconnect cycle replays the held input. A
    // failure with no subsequent drop is a genuine error (bad cwd, unknown
    // profile) and must not retry. An explicit newer intent (pending input or
    // an in-flight mutation) always wins over the stale failure.
    if (wasConnected || !isConnected || !failedCreateInput) {
      return;
    }
    if (pendingCreateInput || createMutation.isPending) {
      setFailedCreateInput(null);
      return;
    }
    if (!canCreateNow) {
      return;
    }
    const retryInput = failedCreateInput;
    setFailedCreateInput(null);
    createMutation.mutate(retryInput);
  }, [canCreateNow, createMutation, failedCreateInput, isConnected, pendingCreateInput]);

  const createTerminal = useCallback(
    (createInput: PendingTerminalCreateInput) => {
      // A fresh explicit intent supersedes any held failure.
      setFailedCreateInput(null);
      if (createMutation.isPending || pendingCreateInput) {
        return;
      }

      if (canCreateNow) {
        createMutation.mutate(createInput);
        return;
      }

      if (hasHydratedWorkspaces && isMissingWorkspaceDirectory) {
        onWorkspacePathUnavailable();
        return;
      }

      setPendingCreateInput(createInput);
      onTerminalCreateQueued();
    },
    [
      canCreateNow,
      createMutation,
      hasHydratedWorkspaces,
      isMissingWorkspaceDirectory,
      onTerminalCreateQueued,
      onWorkspacePathUnavailable,
      pendingCreateInput,
    ],
  );

  const handleScriptTerminalStarted = useCallback(
    (terminalId: string) => {
      setPendingScriptTerminalIds((pendingTerminalIds) => {
        if (pendingTerminalIds.get(terminalId) === query.dataUpdatedAt) {
          return pendingTerminalIds;
        }
        const nextTerminalIds = new Map(pendingTerminalIds);
        nextTerminalIds.set(terminalId, query.dataUpdatedAt);
        return nextTerminalIds;
      });
      onScriptTerminalSelected(terminalId);
      void queryClient.invalidateQueries({ queryKey });
    },
    [onScriptTerminalSelected, query.dataUpdatedAt, queryClient, queryKey],
  );

  const handleViewScriptTerminal = useCallback(
    (terminalId: string) => {
      onScriptTerminalSelected(terminalId);
    },
    [onScriptTerminalSelected],
  );

  const removeTerminalFromCache = useCallback(
    (terminalId: string) => {
      queryClient.setQueryData<ListTerminalsPayload>(
        queryKey,
        removeTerminalFromPayload(terminalId),
      );
    },
    [queryClient, queryKey],
  );

  const invalidateTerminals = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    canCreateNow,
    createMutation,
    createTerminal,
    handleScriptTerminalStarted,
    handleViewScriptTerminal,
    invalidateTerminals,
    killMutation,
    knownTerminalIds,
    liveTerminalIds,
    pendingCreateInput,
    query,
    queryKey,
    removeTerminalFromCache,
    standaloneTerminalIds,
    terminals,
  };
}
