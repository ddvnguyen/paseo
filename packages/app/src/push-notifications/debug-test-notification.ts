import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import Constants from "expo-constants";

/**
 * Sends a local test notification. Works on all builds, including custom
 * self-hosted builds, without requiring FCM/APNs or EAS projectId.
 * For F-Droid builds (where expo-notifications plugin is stripped) this will
 * gracefully fail with a descriptive error.
 */
export async function sendDebugTestNotification(): Promise<{
  ok: boolean;
  error?: string;
}> {
  // F-Droid builds strip expo-notifications — detect via extra flag
  const isFdroidBuild = Boolean(
    (Constants.expoConfig?.extra as { fdroidBuild?: boolean } | undefined)?.fdroidBuild,
  );
  if (isFdroidBuild) {
    return {
      ok: false,
      error: "Notifications are not available in F-Droid builds (no FCM). Use a standard build.",
    };
  }

  // Ensure we have permission (Android 13+ requires runtime POST_NOTIFICATIONS)
  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== Notifications.PermissionStatus.GRANTED) {
    if (!existing.canAskAgain) {
      return { ok: false, error: "Permission denied. Enable notifications in system settings." };
    }
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
    if (status !== Notifications.PermissionStatus.GRANTED) {
      return { ok: false, error: "Permission not granted. Enable notifications in system settings." };
    }
  }

  // Android: ensure channels exist with high importance so heads-up shows on custom builds
  // The default channel is used for immediate (trigger=null) notifications;
  // we also create paseo-debug for future timed tests.
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#20744A",
      sound: "default",
    });
    await Notifications.setNotificationChannelAsync("paseo-debug", {
      name: "Paseo Debug",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#20744A",
      sound: "default",
    });
  }

  // _layout sets shouldShowAlert=false when app is foregrounded, so an immediate
  // local notification would be suppressed. Temporarily allow banner for this test.
  try {
    // Temporarily allow showing while foregrounded so tester sees result without backgrounding
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });

    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Paseo test notification",
        body: "If you see this, local notifications are working \uD83C\uDF89",
        data: { debugTest: true },
        sound: "default",
      },
      trigger: null,
    });

    // Restore handler to app default (suppressed when foregrounded)
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: false,
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });

    return { ok: true };
  } catch (error) {
    // Restore handler on failure as well
    try {
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowAlert: false,
          shouldShowBanner: false,
          shouldShowList: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
        }),
      });
    } catch {}
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
