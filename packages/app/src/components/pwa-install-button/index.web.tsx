import { useCallback, useMemo, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Download, Share, X } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "@/hooks/use-pwa-install";

type BrowserKind = "chrome" | "edge" | "samsung" | "firefox" | "opera" | "safari" | "other";

function detectBrowser(): BrowserKind {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\/|Opera/.test(ua)) return "opera";
  if (/SamsungBrowser\//.test(ua)) return "samsung";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Chrome\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

interface InstallSteps {
  title: string;
  body: string;
}

function resolveInstallSteps(browser: BrowserKind, isIos: boolean): InstallSteps {
  if (isIos) {
    return {
      title: "Add to Home Screen",
      body: "Tap the Share button in Safari's toolbar, then choose “Add to Home Screen”. Paseo will install as a standalone app.",
    };
  }
  switch (browser) {
    case "chrome":
    case "edge":
    case "opera":
      return {
        title: "Install Paseo",
        body: "Click the install icon on the right side of the address bar, or open the menu (⋮) and choose “Install Paseo”. If you don't see the option, reload the page once and try again.",
      };
    case "samsung":
      return {
        title: "Install Paseo",
        body: "Tap the menu (⋮) and choose “Add page to” → “Home screen”. Paseo will be installed as a shortcut.",
      };
    case "firefox":
      return {
        title: "Install Paseo",
        body: "Firefox doesn't support installing Paseo as a standalone app on this device. Use Chrome or Edge for the full app experience.",
      };
    case "safari":
      return {
        title: "Install Paseo",
        body: "Open the File menu and choose “Add to Dock” (Safari 17+, macOS Sonoma or later). Otherwise use Chrome or Edge.",
      };
    default:
      return {
        title: "Install Paseo",
        body: "Use your browser's menu to install Paseo as a standalone app. The exact menu location varies by browser.",
      };
  }
}

const DownloadIcon = ({ color, size }: { color: string; size: number }) => (
  <Download color={color} size={size} strokeWidth={1.75} />
);

const ShareIcon = ({ color, size }: { color: string; size: number }) => (
  <Share color={color} size={size} strokeWidth={1.75} />
);

const CloseIcon = ({ color, size }: { color: string; size: number }) => (
  <X color={color} size={size} strokeWidth={1.75} />
);

interface PwaInstallButtonProps {
  /** Optional override for the install label. */
  label?: string;
}

export function PwaInstallButton({ label }: PwaInstallButtonProps = {}) {
  const { canInstall, isIosUnsupported, showManual, prompt, isIos } = usePwaInstall();
  const [helpOpen, setHelpOpen] = useState(false);

  const browser = useMemo<BrowserKind>(() => detectBrowser(), []);
  const steps = useMemo(() => resolveInstallSteps(browser, isIos), [browser, isIos]);

  const handleInstallPress = useCallback(() => {
    if (canInstall) {
      void prompt();
      return;
    }
    setHelpOpen(true);
  }, [canInstall, prompt]);

  const handleCloseHelp = useCallback(() => setHelpOpen(false), []);

  if (isIosUnsupported) {
    return (
      <>
        <View
          style={styles.hint}
          testID="pwa-install-ios-hint"
          accessibilityRole="text"
          accessibilityLabel={`${steps.title}: open the share menu and choose Add to Home Screen.`}
        >
          <ShareIcon color={styles.hintIcon.color} size={16} />
          <Text style={styles.hintLabel}>{steps.title}</Text>
        </View>
        <InstallHelpModal
          open={helpOpen}
          title={steps.title}
          body={steps.body}
          onClose={handleCloseHelp}
        />
      </>
    );
  }

  if (canInstall || showManual) {
    return (
      <>
        <Button
          variant={canInstall ? "default" : "outline"}
          size="sm"
          onPress={handleInstallPress}
          leftIcon={DownloadIcon}
          testID={canInstall ? "pwa-install-button" : "pwa-install-button-manual"}
          accessibilityRole="button"
          accessibilityLabel={`${steps.title}. Tap for install instructions.`}
        >
          <Text style={canInstall ? styles.activeLabel : styles.label}>{label ?? steps.title}</Text>
        </Button>
        <InstallHelpModal
          open={helpOpen}
          title={steps.title}
          body={steps.body}
          onClose={handleCloseHelp}
        />
      </>
    );
  }

  return null;
}

interface InstallHelpModalProps {
  open: boolean;
  title: string;
  body: string;
  onClose: () => void;
}

function InstallHelpModal({ open, title, body, onClose }: InstallHelpModalProps) {
  const swallowPress = useCallback(() => undefined, []);
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={swallowPress}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{title}</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close"
              testID="pwa-install-help-close"
            >
              <CloseIcon color={styles.modalCloseIcon.color} size={18} />
            </Pressable>
          </View>
          <Text style={styles.modalBody}>{body}</Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: {
    color: theme.colors.foreground,
    fontSize: 13,
    fontWeight: "500",
  },
  activeLabel: {
    color: theme.colors.primaryForeground ?? theme.colors.surface0,
    fontSize: 13,
    fontWeight: "500",
  },
  hint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1] ?? 1,
    borderColor: theme.colors.border,
  },
  hintIcon: {
    color: theme.colors.foregroundMuted,
  },
  hintLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    fontWeight: "500",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: theme.colors.surface1 ?? theme.colors.surface0,
    borderRadius: 12,
    borderWidth: theme.borderWidth[1] ?? 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[4] ?? 16,
    gap: 12,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  modalTitle: {
    color: theme.colors.foreground,
    fontSize: 15,
    fontWeight: "600",
    flex: 1,
  },
  modalCloseIcon: {
    color: theme.colors.foregroundMuted,
  },
  modalBody: {
    color: theme.colors.foregroundMuted,
    fontSize: 13,
    lineHeight: 18,
  },
}));
