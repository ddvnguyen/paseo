import { useCallback, useEffect, useRef } from "react";
import { BackHandler, Platform, ToastAndroid } from "react-native";
import { useRouter } from "expo-router";

const DOUBLE_PRESS_DELAY_MS = 2000;

/**
 * On Android, when the user presses the hardware/gesture back button at the
 * root of the navigation stack, show a short toast and require a second press
 * within {@link DOUBLE_PRESS_DELAY_MS} to exit. When there are screens to go
 * back to, the event is not consumed so React Navigation handles it normally.
 */
export function useAndroidBackToExit() {
  const router = useRouter();
  const lastBackPressRef = useRef(0);

  const handler = useCallback(() => {
    if (router.canGoBack()) {
      return false;
    }

    const now = Date.now();
    if (now - lastBackPressRef.current < DOUBLE_PRESS_DELAY_MS) {
      BackHandler.exitApp();
      return true;
    }

    lastBackPressRef.current = now;
    ToastAndroid.show("Press back again to exit", ToastAndroid.SHORT);
    return true;
  }, [router]);

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }

    const subscription = BackHandler.addEventListener("hardwareBackPress", handler);
    return () => subscription.remove();
  }, [handler]);
}
