import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Download, Share } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { usePwaInstall } from "@/hooks/use-pwa-install";

const IOS_HINT_LABEL = "Add to Home Screen";
const MANUAL_HINT_LABEL = "Install";

const DownloadIcon = ({ color, size }: { color: string; size: number }) => (
  <Download color={color} size={size} strokeWidth={1.75} />
);

const ShareIcon = ({ color, size }: { color: string; size: number }) => (
  <Share color={color} size={size} strokeWidth={1.75} />
);

export function PwaInstallButton() {
  const { canInstall, isIosUnsupported, showManual, prompt } = usePwaInstall();

  const handleInstallPress = useCallback(() => {
    void prompt();
  }, [prompt]);

  if (canInstall) {
    return (
      <Button
        variant="outline"
        size="sm"
        onPress={handleInstallPress}
        leftIcon={DownloadIcon}
        testID="pwa-install-button"
        accessibilityRole="button"
        accessibilityLabel="Install Paseo"
      >
        <Text style={styles.label}>Install</Text>
      </Button>
    );
  }

  if (isIosUnsupported) {
    return (
      <View
        style={styles.iosHint}
        testID="pwa-install-ios-hint"
        accessibilityRole="text"
        accessibilityLabel={`${IOS_HINT_LABEL}: tap the share button, then choose ${IOS_HINT_LABEL}.`}
      >
        <ShareIcon color={styles.iosHintIcon.color} size={16} />
        <Text style={styles.iosHintLabel}>{IOS_HINT_LABEL}</Text>
      </View>
    );
  }

  if (showManual) {
    // Chrome hasn't fired `beforeinstallprompt` yet (or the browser doesn't
    // support it). Show a discoverable button so the user can find the
    // install affordance; the click only succeeds when the event is
    // available.
    return (
      <Button
        variant="outline"
        size="sm"
        onPress={handleInstallPress}
        leftIcon={DownloadIcon}
        testID="pwa-install-button-manual"
        accessibilityRole="button"
        accessibilityLabel="Install Paseo"
      >
        <Text style={styles.label}>{MANUAL_HINT_LABEL}</Text>
      </Button>
    );
  }

  return null;
}

const styles = StyleSheet.create((theme) => ({
  label: {
    color: theme.colors.foreground,
    fontSize: 13,
    fontWeight: "500",
  },
  iosHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: theme.colors.surface0,
  },
  iosHintIcon: {
    color: theme.colors.foregroundMuted,
  },
  iosHintLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    fontWeight: "500",
  },
}));
