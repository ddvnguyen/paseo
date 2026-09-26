import type { ComponentType, ReactNode } from "react";
import { useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import * as hostUi from "@getpaseo/plugin/client/ui";

const styles = StyleSheet.create({
  rowLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  dimmed: { opacity: 0.5 },
  destructiveText: { color: "#c0392b" },
});

/**
 * Defensive access to the host UI kit (owner directive 2026-09-26): older app
 * builds — Android until an APK ships, or a stale web deploy — do not export
 * SettingsIconRow/SettingsIconButton, and rendering an undefined component
 * crashes with React #130. Every accessor resolves the primitive at render
 * time (namespace access, not a top-level named import, so a missing export
 * yields undefined instead of a module-level crash) and substitutes a plain
 * react-native fallback with the same contract.
 */

export interface IconRowProps {
  icon: string;
  label: string;
  hint?: string;
  error?: string | null;
  children?: ReactNode;
  trailing?: ReactNode;
  testID?: string;
}

export interface IconButtonProps {
  icon: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
  testID?: string;
}

export interface InputProps {
  label: string;
  initialValue?: string;
  placeholder?: string;
  onChangeText: (text: string) => void;
  error?: string | null;
}

export interface SwitchProps {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}

export interface CardProps {
  children: ReactNode;
  testID?: string;
}

export function FallbackIconRow({
  icon,
  label,
  hint,
  error,
  children,
  trailing,
  testID,
}: IconRowProps) {
  return (
    <View testID={testID}>
      <View style={styles.rowLine}>
        <Text>{icon}</Text>
        <Text>{label}</Text>
        {hint ? <Text>{hint}</Text> : null}
        {trailing}
      </View>
      {children}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}

export function FallbackIconButton({
  icon,
  accessibilityLabel,
  onPress,
  disabled,
  destructive,
  testID,
}: IconButtonProps) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={disabled ? styles.dimmed : undefined}
    >
      <Text style={destructive ? styles.destructiveText : undefined}>{icon}</Text>
    </Pressable>
  );
}

function MissingPrimitiveInput({ label }: InputProps) {
  return <Text>{`(${label}: input unavailable on this app build)`}</Text>;
}

export function FallbackSwitch({ label, value, onValueChange, disabled, testID }: SwitchProps) {
  const toggle = useCallback(() => onValueChange(!value), [onValueChange, value]);
  const accessibilityState = useCallback(() => ({ checked: value }), [value]);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={toggle}
      testID={testID}
      style={disabled ? styles.dimmed : undefined}
    >
      <Text>{`${label}: ${value ? "on" : "off"}`}</Text>
    </Pressable>
  );
}

/** Host SettingsIconRow, or a plain RN row when the app build lacks it. */
export function resolveIconRow(): ComponentType<IconRowProps> {
  return (
    (hostUi as Record<string, ComponentType<IconRowProps> | undefined>).SettingsIconRow ??
    FallbackIconRow
  );
}

/** Host SettingsIconButton, or a plain RN pressable when the app build lacks it. */
export function resolveIconButton(): ComponentType<IconButtonProps> {
  return (
    (hostUi as Record<string, ComponentType<IconButtonProps> | undefined>).SettingsIconButton ??
    FallbackIconButton
  );
}

/** Host SettingsInput, or a minimal RN substitute when the app build lacks it. */
export function resolveInput(): ComponentType<InputProps> {
  return (
    (hostUi as Record<string, ComponentType<InputProps> | undefined>).SettingsInput ??
    MissingPrimitiveInput
  );
}

/** Host SettingsSwitch, or a styled RN button substitute when the build lacks it. */
export function resolveSwitch(): ComponentType<SwitchProps> {
  return (
    (hostUi as Record<string, ComponentType<SwitchProps> | undefined>).SettingsSwitch ??
    FallbackSwitch
  );
}

/** Host SettingsCard, or a plain RN view when the app build lacks it. */
export function resolveCard(): ComponentType<CardProps> {
  return (hostUi as Record<string, ComponentType<CardProps> | undefined>).SettingsCard ?? View;
}
