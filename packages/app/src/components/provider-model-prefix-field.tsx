import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { formatProviderModelPrefix } from "@/provider-selection/provider-model-prefix";
import { resolveModelPrefixFieldState } from "./provider-model-prefix-field";

export interface ProviderModelPrefixFieldProps {
  /** The tag currently in config; undefined means no tag. */
  storedPrefix: string | undefined;
  /** Receives the value to persist, or undefined to clear the tag. */
  onSave: (prefix: string | undefined) => void;
  /** Mirrors the save in flight so the control can hold itself disabled. */
  isSaving: boolean;
  visible: boolean;
}

/**
 * Per-provider model tag. Renders the field and dispatches the save; every rule
 * about what counts as a valid prefix lives in `provider-model-prefix-field`.
 *
 * The typed text is an override rather than a copy: with nothing typed the field
 * shows the stored value, so a config change made elsewhere appears on reopen
 * without this component holding a second copy of it. `visible` drops the
 * override, matching how the rest of the provider sheet discards its drafts.
 */
export function ProviderModelPrefixField({
  storedPrefix,
  onSave,
  isSaving,
  visible,
}: ProviderModelPrefixFieldProps) {
  const { t } = useTranslation();
  const controlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setDraft(null);
    }
  }, [visible]);

  const text = draft ?? storedPrefix ?? "";
  const fieldState = useMemo(
    () => resolveModelPrefixFieldState(text, storedPrefix),
    [storedPrefix, text],
  );

  const preview = useMemo(() => {
    if (!fieldState.isValid) {
      return "";
    }
    if (fieldState.normalized === undefined) {
      return t("settings.providers.modelPrefix.cleared");
    }
    return t("settings.providers.modelPrefix.preview", {
      tag: formatProviderModelPrefix(fieldState.normalized),
    });
  }, [fieldState.isValid, fieldState.normalized, t]);

  const handleChangeText = useCallback((value: string) => {
    setDraft(value);
  }, []);

  const handleSave = useCallback(() => {
    if (!fieldState.isValid) {
      return;
    }
    onSave(fieldState.normalized);
  }, [fieldState.isValid, fieldState.normalized, onSave]);

  const saveAction = useMemo(
    () => (
      <Button
        variant="secondary"
        size="sm"
        onPress={handleSave}
        disabled={!fieldState.isDirty || !fieldState.isValid}
        loading={isSaving}
        testID="provider-model-prefix-save"
        accessibilityLabel={t("settings.providers.modelPrefix.saveAccessibility")}
      >
        {t("settings.providers.modelPrefix.save")}
      </Button>
    ),
    [fieldState.isDirty, fieldState.isValid, handleSave, isSaving, t],
  );

  // Deliberately excludes the draft: the editing surface already holds what the
  // user typed, and re-seeding on every keystroke would fight its IME. It moves
  // when the field reopens or when the stored value changes underneath it.
  const resetKey = `provider-modelPrefix-${visible ? "open" : "closed"}-${storedPrefix ?? "none"}`;

  return (
    <Field
      label={t("settings.providers.modelPrefix.label")}
      testID="provider-model-prefix"
      hint={preview}
      error={fieldState.isValid ? null : t("settings.providers.modelPrefix.invalid")}
      trailing={saveAction}
    >
      <FormTextInput
        size={controlSize}
        testID="provider-model-prefix-input"
        accessibilityLabel={t("settings.providers.modelPrefix.accessibilityLabel")}
        initialValue={text}
        resetKey={resetKey}
        onChangeText={handleChangeText}
        onSubmitEditing={handleSave}
        placeholder={t("settings.providers.modelPrefix.placeholder")}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
      />
    </Field>
  );
}
