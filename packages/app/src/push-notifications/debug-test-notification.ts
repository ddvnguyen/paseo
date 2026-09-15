import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { isAndroid, isWeb } from "@/constants/platform";
import { sendOsNotification } from "@/utils/os-notifications";

const DEBUG_NOTIFICATION_PRESENT_TIMEOUT_MS = 8000;

/**
 * Sends a local test notification. Works on all builds, including custom
 * self-hosted builds, without requiring FCM/APNs or EAS projectId.
 * For F-Droid builds (where expo-notifications plugin is stripped) this will
 * gracefully fail with a descriptive error.
 *
 * Web has no expo notification scheduler, so the test goes through the Web
 * Notification API instead. On native the banner handler stays permissive
 * until the OS presents the notification: restoring it right after schedule
 * resolves loses the race and the foreground banner never shows.
 */
export async function sendDebugTestNotification(): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (isWeb) {
    const sent = await sendOsNotification({
      title: "Paseo test notification",
      body: "If you see this, notifications are working 🎉",
      data: { debugTest: true },
    });
    return sent
      ? { ok: true }
      : { ok: false, error: "Web notifications unavailable. Allow notification access first." };
  }
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
      return {
        ok: false,
        error: "Permission not granted. Enable notifications in system settings.",
      };
    }
  }

  if (isAndroid) {
    // The default channel is used for immediate (trigger=null) notifications;
    // we also create paseo-debug for future timed tests.
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
  const restoreDefaultHandler = (): void => {
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
    } catch {
      // Restoring is best-effort; the OS keeps the last handler it received.
    }
  };
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

  try {
    const identifier = await Notifications.scheduleNotificationAsync({
      content: {
        title: "Paseo test notification",
        body: "If you see this, local notifications are working 🎉",
        data: { debugTest: true },
        sound: "default",
      },
      trigger: null,
    });
    // Presentation is async: wait until the OS hands the notification back
    // (or time out) before restoring, otherwise the banner decision races us.
    await waitForNotificationPresented(identifier);
    restoreDefaultHandler();
    return { ok: true };
  } catch (error) {
    restoreDefaultHandler();
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

async function waitForNotificationPresented(identifier: string): Promise<void> {
  let removeListener: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      const timeout = setTimeout(settle, DEBUG_NOTIFICATION_PRESENT_TIMEOUT_MS);
      const subscription = Notifications.addNotificationReceivedListener((event) => {
        if (event.request.identifier === identifier) {
          clearTimeout(timeout);
          settle();
        }
      });
      removeListener = (): void => subscription.remove();
    });
  } finally {
    try {
      removeListener?.();
    } catch {
      // Listener cleanup is best-effort.
    }
  }
}
