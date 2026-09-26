import {
  Children,
  isValidElement,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  SettingsIconButtonProps,
  SettingsIconRowProps,
  SettingsRowProps,
  SettingsSwitchProps,
  SettingsSelectProps,
  SettingsInputProps,
  SettingsActionProps,
} from "@getpaseo/plugin/client/ui";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import {
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Icon } from "@/plugins/icons";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
export { SettingsGroup } from "./headings/settings-group";
export { SettingsSection } from "./headings/settings-section";

interface AppSettingsRowProps extends Omit<SettingsRowProps, "hint"> {
  hint?: ReactNode;
  labelAccessory?: ReactNode;
}

export function SettingsCard({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View style={settingsStyles.card} testID={testID}>
      {Children.toArray(children).map((child, index) => (
        <View
          key={isValidElement(child) ? child.key : index}
          style={index ? settingsStyles.rowBorder : undefined}
        >
          {child}
        </View>
      ))}
    </View>
  );
}

export function SettingsRow({
  label,
  labelAccessory,
  hint,
  error,
  children,
  testID,
}: AppSettingsRowProps) {
  const compact = useIsCompactFormFactor();
  const rowStyle = useMemo(() => [settingsStyles.row, compact && styles.compactRow], [compact]);
  return (
    <View style={rowStyle} testID={testID}>
      <View style={styles.label}>
        {labelAccessory ? (
          <View style={styles.labelRow}>
            <Text style={[settingsStyles.rowTitle, styles.accessoryLabel]}>{label}</Text>
            {labelAccessory}
          </View>
        ) : (
          <Text style={settingsStyles.rowTitle}>{label}</Text>
        )}
        {typeof hint === "string" ? <Text style={settingsStyles.rowHint}>{hint}</Text> : hint}
        {error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {error}
          </Text>
        ) : null}
      </View>
      {children ? <View style={styles.control}>{children}</View> : null}
    </View>
  );
}

export function SettingsSwitch({ value, onValueChange, disabled, ...row }: SettingsSwitchProps) {
  return (
    <SettingsRow {...row}>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={row.label}
      />
    </SettingsRow>
  );
}

function SettingsOption<Value extends string>({
  option,
  selected,
  onValueChange,
}: {
  option: { label: string; value: Value };
  selected: boolean;
  onValueChange(value: Value): void;
}) {
  const select = useCallback(() => onValueChange(option.value), [onValueChange, option.value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={select}>
      {option.label}
    </DropdownMenuItem>
  );
}

export function SettingsSelect<Value extends string>({
  value,
  options,
  onValueChange,
  disabled,
  ...row
}: SettingsSelectProps<Value>) {
  return (
    <SettingsRow {...row}>
      <DropdownMenu>
        <DropdownTrigger
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={row.label}
        >
          <Text style={styles.value}>
            {options.find((option) => option.value === value)?.label ?? value}
          </Text>
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={220}>
          {options.map((option) => (
            <SettingsOption
              key={option.value}
              option={option}
              selected={option.value === value}
              onValueChange={onValueChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}

export function SettingsInput({
  initialValue,
  onChangeText,
  placeholder,
  disabled,
  secureTextEntry,
  ref,
  ...row
}: SettingsInputProps) {
  const compact = useIsCompactFormFactor();
  const input = useRef<EditingTextInputHandle>(null);
  useImperativeHandle(
    ref,
    () => ({
      focus: () => input.current?.focus(),
      blur: () => input.current?.blur(),
      getText: () => input.current?.getText() ?? "",
      replaceText: (text) => input.current?.replaceText(text),
    }),
    [],
  );
  return (
    <SettingsRow {...row}>
      <FormTextInput
        ref={input}
        initialValue={initialValue}
        onChangeText={onChangeText}
        placeholder={placeholder}
        editable={!disabled}
        secureTextEntry={secureTextEntry}
        accessibilityLabel={row.label}
        size={compact ? "md" : "sm"}
        style={styles.input}
      />
    </SettingsRow>
  );
}

export function SettingsAction({ actionLabel, onPress, disabled, ...row }: SettingsActionProps) {
  return (
    <SettingsRow {...row}>
      <Button variant="outline" size="sm" onPress={onPress} disabled={disabled}>
        {actionLabel}
      </Button>
    </SettingsRow>
  );
}

const ThemedSettingsIcon = withUnistyles(Icon);

function settingsIconButtonUniProps(destructive: boolean) {
  return destructive
    ? (theme: Theme) => ({ color: theme.colors.statusDanger })
    : mutedIconColorMapping;
}

export function SettingsIconButton({
  icon,
  accessibilityLabel,
  onPress,
  disabled,
  destructive,
  testID,
}: SettingsIconButtonProps) {
  const compact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const uniProps = useMemo(() => settingsIconButtonUniProps(destructive ?? false), [destructive]);
  const accessibilityState = useMemo(() => ({ disabled: disabled ?? false }), [disabled]);
  return (
    <Tooltip enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={accessibilityState}
          disabled={disabled}
          onPress={onPress}
          onHoverIn={handleHoverIn}
          onHoverOut={handleHoverOut}
          style={iconButtonChromeStyle({
            size: "small",
            compact,
            disabled,
            state: { hovered },
          })}
          testID={testID}
        >
          <ThemedSettingsIcon
            name={icon}
            size={iconButtonChromeGlyphSize("small", compact)}
            uniProps={uniProps}
          />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent>
        <Text style={styles.tooltipLabel}>{accessibilityLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

export function SettingsIconRow({
  icon,
  label,
  hint,
  error,
  children,
  trailing,
  testID,
}: SettingsIconRowProps) {
  const compact = useIsCompactFormFactor();
  return (
    <View style={[settingsStyles.row, compact && styles.stackedRow]} testID={testID}>
      <View style={styles.rowIcon}>
        <ThemedSettingsIcon name={icon} size={14} uniProps={mutedIconColorMapping} />
      </View>
      <View style={styles.rowBody}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        {typeof hint === "string" ? <Text style={settingsStyles.rowHint}>{hint}</Text> : hint}
        {children}
        {error ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {error}
          </Text>
        ) : null}
      </View>
      {trailing ? (
        <View
          style={[styles.trailing, compact && styles.trailingStacked]}
          testID={testID ? `${testID}-trailing` : undefined}
        >
          {trailing}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  compactRow: { flexWrap: "wrap", gap: theme.spacing[3] },
  label: { flexGrow: 1, flexShrink: 1, flexBasis: 160, marginRight: theme.spacing[3] },
  labelRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  accessoryLabel: { flexShrink: 1, minWidth: 0 },
  control: { flexShrink: 1, maxWidth: "100%" },
  value: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  input: { minWidth: 180 },
  tooltipLabel: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  stackedRow: { flexDirection: "column", alignItems: "stretch" },
  // Optical nudge: aligns the 14px glyph with the row title's cap height.
  rowIcon: { alignSelf: "flex-start", marginTop: 2, marginRight: theme.spacing[3] },
  rowBody: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
    marginLeft: theme.spacing[3],
  },
  // Stacked trailing stays on the card's leading rail, below the content.
  trailingStacked: { marginLeft: 0, marginTop: theme.spacing[3], alignSelf: "flex-start" },
}));
