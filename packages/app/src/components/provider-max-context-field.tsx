import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  formatMaxContextTokenCount,
  formatMaxContextTokens,
  parseMaxContextTokens,
  resolveMaxContextFieldState,
} from "./provider-max-context";

export interface ProviderMaxContextFieldProps {
  /** The ceiling currently in config; undefined means no limit. */
  storedTokens: number | undefined;
  /** Receives the value to persist, or undefined to clear the ceiling. */
  onSave: (tokens: number | undefined) => void;
  /** Mirrors the save in flight so the control can hold itself disabled. */
  isSaving: boolean;
  visible: boolean;
}

/**
 * Per-provider context ceiling. Renders the field and dispatches the save; every
 * rule about what counts as a valid number lives in `provider-max-context`.
 *
 * The typed text is an override rather than a copy: with nothing typed the field
 * shows the stored value, so a config change made elsewhere appears on reopen
 * without this component holding a second copy of it. `visible` drops the
 * override, matching how the rest of the provider sheet discards its drafts.
 */
export function ProviderMaxContextField({
  storedTokens,
  onSave,
  isSaving,
  visible,
}: ProviderMaxContextFieldProps) {
  const { t, i18n } = useTranslation();
  const controlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setDraft(null);
    }
  }, [visible]);

  const text = draft ?? formatMaxContextTokens(storedTokens);
  const fieldState = useMemo(
    () => resolveMaxContextFieldState(text, storedTokens),
    [storedTokens, text],
  );

  const preview = useMemo(() => {
    if (fieldState.previewTokens === undefined) {
      return t("settings.providers.maxContext.unlimited");
    }
    return t("settings.providers.maxContext.preview", {
      tokens: formatMaxContextTokenCount(fieldState.previewTokens, i18n.language),
    });
  }, [fieldState.previewTokens, i18n.language, t]);

  const handleChangeText = useCallback((value: string) => {
    setDraft(value);
  }, []);

  const handleSave = useCallback(() => {
    const parsed = parseMaxContextTokens(text);
    if (parsed.status === "invalid") {
      return;
    }
    onSave(parsed.status === "valid" ? parsed.tokens : undefined);
  }, [onSave, text]);

  const saveAction = useMemo(
    () => (
      <Button
        variant="secondary"
        size="sm"
        onPress={handleSave}
        disabled={!fieldState.isDirty || !fieldState.isValid}
        loading={isSaving}
        testID="provider-max-context-save"
        accessibilityLabel={t("settings.providers.maxContext.saveAccessibility")}
      >
        {t("settings.providers.maxContext.save")}
      </Button>
    ),
    [fieldState.isDirty, fieldState.isValid, handleSave, isSaving, t],
  );

  // Deliberately excludes the draft: the editing surface already holds what the
  // user typed, and re-seeding on every keystroke would fight its IME. It moves
  // when the field reopens or when the stored value changes underneath it.
  const resetKey = `provider-max-context-${visible ? "open" : "closed"}-${storedTokens ?? "none"}`;

  return (
    <Field
      label={t("settings.providers.maxContext.label")}
      testID="provider-max-context"
      hint={preview}
      error={fieldState.isValid ? null : t("settings.providers.maxContext.invalid")}
      trailing={saveAction}
    >
      <FormTextInput
        size={controlSize}
        testID="provider-max-context-input"
        accessibilityLabel={t("settings.providers.maxContext.accessibilityLabel")}
        initialValue={text}
        resetKey={resetKey}
        onChangeText={handleChangeText}
        onSubmitEditing={handleSave}
        placeholder={t("settings.providers.maxContext.placeholder")}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
      />
    </Field>
  );
}
