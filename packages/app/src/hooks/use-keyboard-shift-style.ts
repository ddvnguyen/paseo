import { createElement, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import type { ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useGenericKeyboardHandler,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import {
  useAnimatedStyle,
  useAnimatedReaction,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  DEFAULT_IOS_KEYBOARD_INSET_MIN_HEIGHT,
  resolveKeyboardShift,
  shouldReconcileHiddenKeyboardEnd,
} from "@/hooks/keyboard-shift-policy";
import { isWeb } from "@/constants/platform";
import {
  KeyboardShiftContext,
  SettledKeyboardShiftContext,
  useKeyboardShift,
} from "@/hooks/keyboard-shift-context";

type KeyboardShiftMode = "translate" | "padding";

export function KeyboardShiftProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const { height: keyboardHeight, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const bottomInset = useSharedValue(insets.bottom);
  const isIos = Platform.OS === "ios";
  const isMoving = useSharedValue(false);
  const [settledShift, setSettledShift] = useState(0);
  const publishSettledShift = useCallback((nextShift: number) => {
    setSettledShift((currentShift) => (currentShift === nextShift ? currentShift : nextShift));
  }, []);

  useEffect(() => {
    bottomInset.value = insets.bottom;
  }, [bottomInset, insets.bottom]);

  // Web fallback: react-native-keyboard-controller's
  // `useReanimatedKeyboardAnimation` returns height: 0 on web because the
  // library has no DOM soft-keyboard observation. Drive the same shared
  // value from `window.visualViewport`, which shrinks when the soft
  // keyboard (Android Chrome, mobile Safari, iPadOS) covers the bottom of
  // the screen. The diff between the layout viewport and the visual
  // viewport is exactly the keyboard inset.
  useEffect(() => {
    if (!isWeb) return;
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const layout = window.innerHeight;
      const visual = vv.height;
      const inset = Math.max(0, layout - visual - vv.offsetTop);
      keyboardHeight.value = -inset;
      const progress = inset > 0 ? Math.min(1, inset / 200) : 0;
      keyboardProgress.value = progress;
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [keyboardHeight, keyboardProgress]);


  const shift = useDerivedValue(() => {
    "worklet";
    return resolveKeyboardShift({
      rawKeyboardHeight: Math.abs(keyboardHeight.value),
      keyboardProgress: keyboardProgress.value,
      bottomInset: bottomInset.value,
      isIos,
      iosMinHeight: DEFAULT_IOS_KEYBOARD_INSET_MIN_HEIGHT,
    });
  });

  useGenericKeyboardHandler(
    {
      onStart: () => {
        "worklet";
        isMoving.value = true;
      },
      onEnd: (event) => {
        "worklet";
        if (isIos && shouldReconcileHiddenKeyboardEnd(event)) {
          keyboardHeight.value = 0;
          keyboardProgress.value = 0;
        }
        isMoving.value = false;
      },
    },
    [isIos, isMoving, keyboardHeight, keyboardProgress],
  );

  useAnimatedReaction(
    () => ({ moving: isMoving.value, shift: shift.value }),
    (current, previous) => {
      if (!current.moving && (previous === null || previous.moving)) {
        scheduleOnRN(publishSettledShift, current.shift);
      }
    },
    [isMoving, publishSettledShift, shift],
  );

  const value = useMemo(
    () => ({
      shift,
      isMoving,
      bottomInset,
    }),
    [bottomInset, isMoving, shift],
  );

  return createElement(
    KeyboardShiftContext.Provider,
    { value },
    createElement(SettledKeyboardShiftContext.Provider, { value: settledShift }, children),
  );
}

export function useKeyboardShiftStyle(input: { mode: KeyboardShiftMode; enabled?: boolean }): {
  shift: SharedValue<number>;
  style: ReturnType<typeof useAnimatedStyle<ViewStyle>>;
} {
  const { shift, bottomInset } = useKeyboardShift();
  const mode = input.mode;
  const enabled = input.enabled ?? true;

  const style = useAnimatedStyle<ViewStyle>(() => {
    "worklet";
    if (mode === "padding") {
      if (!enabled) {
        return { paddingBottom: 0 };
      }
      // Include safe-area bottom inset so content clears the home indicator even without a keyboard.
      return { paddingBottom: bottomInset.value + shift.value };
    }

    return { transform: [{ translateY: enabled ? -shift.value : 0 }] };
  }, [enabled, mode]);

  return { shift, style };
}
