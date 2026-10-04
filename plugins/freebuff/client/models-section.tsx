import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsIconRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Text } from "react-native";

import { freebuffModelsList, freebuffModelsSetEnabled } from "../shared/models";

/** One catalog row: cost-to-open details plus the global enable switch. */
function ModelRow({
  model,
  theme,
  switchDisabled,
  onToggle,
}: {
  model: {
    id: string;
    name: string;
    tagline: string;
    priceFreebucks?: number;
    sessionLifetimeLabel: string;
    priceNotices?: string;
    enabled: boolean;
  };
  theme: PluginSurfaceProps["theme"];
  switchDisabled: boolean;
  onToggle(id: string, enabled: boolean): void;
}) {
  const styles = useMemo(() => ({ muted: { color: theme.colors.foregroundMuted } }), [theme]);
  const handleToggle = useCallback(
    (enabled: boolean) => {
      onToggle(model.id, enabled);
    },
    [model.id, onToggle],
  );
  const enabledControl = useMemo(
    () => (
      <SettingsSwitch
        label="Enabled"
        value={model.enabled}
        disabled={switchDisabled}
        onValueChange={handleToggle}
        testID={`freebuff-model-enabled-${model.id}`}
      />
    ),
    [model.enabled, model.id, switchDisabled, handleToggle],
  );
  return (
    <SettingsIconRow
      icon="Sparkles"
      label={model.name}
      hint={model.tagline}
      testID={`freebuff-model-${model.id}`}
      trailing={enabledControl}
    >
      <Text style={styles.muted}>
        {model.priceFreebucks !== undefined
          ? `${model.priceFreebucks} Freebucks · ${model.sessionLifetimeLabel} session${
              model.priceNotices ? ` (${model.priceNotices})` : ""
            }`
          : "price unavailable"}
      </Text>
    </SettingsIconRow>
  );
}

/** Model catalog with cost-to-open details and global enable switches. */
export function ModelsSection({ theme }: { theme: PluginSurfaceProps["theme"] }) {
  const readModels = useRpc(freebuffModelsList);
  const writeEnabled = useRpc(freebuffModelsSetEnabled);
  const toast = useToast();
  const queryClient = useQueryClient();
  const modelsQuery = useQuery({
    queryKey: ["freebuff-models"],
    queryFn: () => readModels({}),
  });
  const setEnabledMutation = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => writeEnabled(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["freebuff-models"] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const models = useMemo(() => modelsQuery.data?.models ?? [], [modelsQuery.data]);
  const warning = modelsQuery.data?.modelCheck;
  const styles = useMemo(
    () => ({
      muted: { color: theme.colors.foregroundMuted },
      warning: { color: theme.colors.statusWarning },
    }),
    [theme],
  );
  const handleToggle = useCallback(
    (id: string, enabled: boolean) => {
      setEnabledMutation.mutate({ id, enabled });
    },
    [setEnabledMutation],
  );

  return (
    <SettingsSection
      title="Models"
      info="Cost to open a session and whether the adapter offers each model. Switches apply to every account."
    >
      {modelsQuery.isPending ? <Text style={styles.muted}>Loading models…</Text> : null}
      {modelsQuery.isError ? (
        <Text accessibilityRole="alert">{modelsQuery.error.message}</Text>
      ) : null}
      {warning ? (
        <Text accessibilityRole="alert" style={styles.warning} testID="freebuff-models-warning">
          {warning}
        </Text>
      ) : null}
      {models.map((model) => (
        <ModelRow
          key={model.id}
          model={model}
          theme={theme}
          switchDisabled={setEnabledMutation.isPending}
          onToggle={handleToggle}
        />
      ))}
    </SettingsSection>
  );
}
