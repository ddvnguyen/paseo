import { useEffect, useMemo } from "react";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useExcludedModelIdsByProvider } from "@/stores/disabled-models-store";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { buildProviderModelPrefixes } from "@/provider-selection/provider-model-prefix";
import type { ScheduleFormModel, ScheduleFormState } from "./schedule-form-model";

export function useScheduleFormProviderSnapshot(
  model: ScheduleFormModel,
  state: ScheduleFormState,
) {
  const serverId = state.providerSnapshotRequest?.serverId ?? state.selectedServerId;
  const cwd = state.providerSnapshotRequest?.cwd ?? state.workingDir;
  const enabled = state.targetKind === "new-agent" && Boolean(serverId && cwd.trim());
  const snapshot = useProvidersSnapshot(serverId ?? null, {
    cwd,
    enabled,
  });
  // Disabled models stay hidden from new selection (C2); re-applied live.
  const excludedByProvider = useExcludedModelIdsByProvider(serverId ?? null);
  const { config: daemonConfig } = useDaemonConfig(serverId ?? null);
  const modelPrefixesByProvider = useMemo(
    () => buildProviderModelPrefixes(daemonConfig),
    [daemonConfig],
  );

  useEffect(() => {
    if (!enabled || !serverId || !snapshot.entries) {
      return;
    }
    model.applyProviderSnapshot(serverId, {
      entries: snapshot.entries,
      excludedByProvider,
      modelPrefixesByProvider,
    });
  }, [enabled, excludedByProvider, model, modelPrefixesByProvider, serverId, snapshot.entries]);

  return snapshot;
}
