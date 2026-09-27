import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

/**
 * Host-level per-provider disabled model ids (C2). A UI preference only: the
 * server never sees this set, so running agents and stored profiles keep
 * working — pickers simply hide disabled models from new selection.
 *
 * Keys are matched exactly (no trimming): model ids are lookup keys, and a
 * stored key that differs from the catalog id would silently never match.
 */

interface DisabledModelsStoreState {
  disabledByServerProvider: Record<string, Record<string, string[]>>;
  isModelDisabled: (serverId: string, providerId: string, modelId: string) => boolean;
  getDisabledModelIds: (serverId: string, providerId: string) => string[];
  setModelDisabled: (
    serverId: string,
    providerId: string,
    modelId: string,
    disabled: boolean,
  ) => void;
}

const DisabledModelsPersistedStateSchema = z.strictObject({
  disabledByServerProvider: z.record(z.string(), z.record(z.string(), z.array(z.string()))),
});

function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}

/**
 * Last-enabled guard: disabling `modelId` must not leave the provider with
 * zero enabled models. `catalogIds` are the currently selectable ids.
 */
export function isLastEnabledModel(
  disabledIds: string[],
  catalogIds: string[],
  modelId: string,
): boolean {
  if (!catalogIds.includes(modelId)) return false;
  if (disabledIds.includes(modelId)) return false;
  return catalogIds.every((id) => id === modelId || disabledIds.includes(id));
}

export const useDisabledModelsStore = create<DisabledModelsStoreState>()(
  persist(
    (set, get) => ({
      disabledByServerProvider: {},
      isModelDisabled: (serverId, providerId, modelId) => {
        if (!serverId || !providerId || !modelId) return false;
        return get().disabledByServerProvider[serverId]?.[providerId]?.includes(modelId) ?? false;
      },
      getDisabledModelIds: (serverId, providerId) => {
        if (!serverId || !providerId) return [];
        return get().disabledByServerProvider[serverId]?.[providerId] ?? [];
      },
      setModelDisabled: (serverId, providerId, modelId, disabled) => {
        if (!serverId || !providerId || !modelId) return;
        set((state) => {
          const byProvider = state.disabledByServerProvider[serverId] ?? {};
          const current = byProvider[providerId] ?? [];
          const next = disabled
            ? dedupeIds([...current, modelId])
            : current.filter((id) => id !== modelId);
          // Prune empty leaves so storage stays small and shape stays clean.
          const nextByProvider: Record<string, string[]> = { ...byProvider };
          if (next.length === 0) {
            delete nextByProvider[providerId];
          } else {
            nextByProvider[providerId] = next;
          }
          const nextRoot: Record<string, Record<string, string[]>> = {
            ...state.disabledByServerProvider,
          };
          if (Object.keys(nextByProvider).length === 0) {
            delete nextRoot[serverId];
          } else {
            nextRoot[serverId] = nextByProvider;
          }
          return { disabledByServerProvider: nextRoot };
        });
      },
    }),
    {
      name: "disabled-provider-models",
      storage: createValidatedPersistStorage(AsyncStorage, DisabledModelsPersistedStateSchema),
      partialize: (state) => ({ disabledByServerProvider: state.disabledByServerProvider }),
      version: 1,
    },
  ),
);
