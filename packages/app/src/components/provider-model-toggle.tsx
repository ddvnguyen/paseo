import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { Switch } from "@/components/ui/switch";
import { isLastEnabledModel, useDisabledModelsStore } from "@/stores/disabled-models-store";

const EMPTY_DISABLED_IDS: string[] = [];

const fallbackToggleStyle: ViewStyle = { alignItems: "flex-end", gap: 4 };

/**
 * Per-model visibility toggle (C2). ON = the model appears in pickers.
 * Self-subscribes to the disabled-models store so rows stay dumb. Turning
 * OFF the last enabled model is blocked with a visible hint instead.
 */
export function ModelDisableSwitch({
  serverId,
  provider,
  modelId,
  modelLabel,
  catalogIds,
  style,
  hintStyle,
}: {
  serverId: string;
  provider: string;
  modelId: string;
  modelLabel: string;
  catalogIds: string[];
  style?: StyleProp<ViewStyle>;
  hintStyle?: StyleProp<TextStyle>;
}) {
  const { t } = useTranslation();
  const disabledIds = useDisabledModelsStore(
    (state) => state.disabledByServerProvider[serverId]?.[provider] ?? EMPTY_DISABLED_IDS,
  );
  const setModelDisabled = useDisabledModelsStore((state) => state.setModelDisabled);
  const disabled = disabledIds.includes(modelId);
  const blocked = !disabled && isLastEnabledModel(disabledIds, catalogIds, modelId);
  const handleValueChange = useCallback(
    (value: boolean) => {
      setModelDisabled(serverId, provider, modelId, !value);
    },
    [serverId, provider, modelId, setModelDisabled],
  );

  return (
    <View style={style ?? fallbackToggleStyle}>
      <Switch
        value={!disabled}
        onValueChange={handleValueChange}
        disabled={blocked}
        accessibilityLabel={t(
          disabled
            ? "settings.providers.models.enableModel"
            : "settings.providers.models.disableModel",
          { id: modelLabel },
        )}
      />
      {blocked ? (
        <Text style={hintStyle}>{t("settings.providers.models.lastModelHint")}</Text>
      ) : null}
    </View>
  );
}
