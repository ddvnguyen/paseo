import { useEffect } from "react";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useExcludedModelIdsByProvider } from "@/stores/disabled-models-store";
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

  useEffect(() => {
    if (!enabled || !serverId || !snapshot.entries) {
      return;
    }
    model.applyProviderSnapshot(serverId, { entries: snapshot.entries, excludedByProvider });
  }, [enabled, excludedByProvider, model, serverId, snapshot.entries]);

  return snapshot;
}
