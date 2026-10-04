import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";

interface ConfirmModalProps {
  title: string;
  message: string;
  open: boolean;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  theme: PluginSurfaceProps["theme"];
  onConfirm(): void;
  onCancel(): void;
}

/**
 * Confirmation dialog over the host Modal: message, Cancel, and one
 * confirm action the caller wires to a mutation.
 */
export function ConfirmModal({
  title,
  message,
  open,
  confirmLabel,
  busyLabel,
  busy,
  theme,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const styles = useMemo(
    () => ({
      body: { gap: 16 },
      message: { color: theme.colors.foreground },
      buttons: { flexDirection: "row" as const, gap: 12 },
      cancel: {
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      cancelText: { color: theme.colors.foreground },
      confirm: {
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: 10,
        backgroundColor: theme.colors.accent,
      },
      confirmText: { color: theme.colors.accentForeground },
    }),
    [theme],
  );
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) onCancel();
    },
    [onCancel],
  );
  return (
    <Modal title={title} open={open} onOpenChange={handleOpenChange}>
      <Modal.Content>
        <View style={styles.body}>
          <Text style={styles.message}>{message}</Text>
          <View style={styles.buttons}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={onCancel}
              style={styles.cancel}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={busy ? (busyLabel ?? confirmLabel) : confirmLabel}
              disabled={busy}
              onPress={onConfirm}
              style={styles.confirm}
            >
              <Text style={styles.confirmText}>
                {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
