import { useCallback, useMemo } from "react";
import { Gesture } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { router } from "expo-router";
import { scheduleOnRN } from "react-native-worklets";
import { isWeb } from "@/constants/platform";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { usePanelStore } from "@/stores/panel-store";
import { canBeginMobilePanelGesture, isMobilePanelGestureCurrent } from "./model";
import { useMobilePanelsRuntime } from "./provider";
import { resolveMobilePanelGestureIntent } from "./gesture-intent";

const MOBILE_WEB_EDGE_SWIPE_WIDTH = 32;
// Reserve the outer 32px on each side for the panel open gestures so they
// don't fight the back-swipe gesture. Anything in the central area is fair
// game for navigation.
const MOBILE_WEB_BACK_SWIPE_EDGE_BUFFER = 32;
// Activate back navigation after ~30% of the screen width, the same threshold
// the close-panel gestures use.
const BACK_SWIPE_ACTIVATION_RATIO = 0.3;
// Reject the gesture if the user has moved vertically more than this fraction
// of the travel distance — a clear sign the user meant to scroll, not swipe.
const BACK_SWIPE_VERTICAL_REJECT = 0.6;

function isCurrentSelection(startedRevision: number): boolean {
  return usePanelStore.getState().mobilePanel.revision === startedRevision;
}

function useGestureState() {
  return {
    startedRevision: useSharedValue(-1),
    touchStartX: useSharedValue(0),
    touchStartY: useSharedValue(0),
  };
}

function useRevisionCommit(action: () => void) {
  return useCallback(
    (revision: number) => {
      if (isCurrentSelection(revision)) {
        action();
      }
    },
    [action],
  );
}

export function useOpenAgentListGesture(enabled: boolean) {
  const {
    beginGesture,
    finishGesture,
    leftOpenGestureRef,
    motionState,
    openGesturesBlocked,
    position,
    updateGesture,
    windowWidth,
  } = useMobilePanelsRuntime();
  const horizontalScroll = useHorizontalScrollOptional();
  const { startedRevision, touchStartX, touchStartY } = useGestureState();
  const showMobileAgentList = usePanelStore((state) => state.showMobileAgentList);
  const commit = useRevisionCommit(showMobileAgentList);

  return useMemo(
    () =>
      Gesture.Pan()
        .withRef(leftOpenGestureRef)
        .enabled(enabled)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (isMobilePanelGestureCurrent(motionState.value, startedRevision.value)) {
            return;
          }

          const panIntent = resolveMobilePanelGestureIntent({
            deltaX,
            deltaY,
            direction: 1,
            openGesturesBlocked: openGesturesBlocked.value,
          });
          if (
            !canBeginMobilePanelGesture(motionState.value, "agent", position.value) ||
            horizontalScroll?.isAnyScrolledRight.value ||
            (isWeb && touchStartX.value > MOBILE_WEB_EDGE_SWIPE_WIDTH) ||
            panIntent === "fail"
          ) {
            stateManager.fail();
            return;
          }
          if (panIntent === "activate") {
            stateManager.activate();
          }
        })
        .onStart(() => {
          startedRevision.value = beginGesture({ origin: "agent", preview: "agent-list" });
        })
        .onUpdate((event) => {
          updateGesture(startedRevision.value, -event.translationX / windowWidth);
        })
        .onEnd((event, success) => {
          const shouldOpen = event.translationX > windowWidth / 3 || event.velocityX > 500;
          const result = finishGesture({
            startedRevision: startedRevision.value,
            target: shouldOpen ? "agent-list" : "agent",
            success,
          });
          if (result) {
            scheduleOnRN(commit, result.startedRevision);
          }
        }),
    [
      commit,
      enabled,
      beginGesture,
      finishGesture,
      horizontalScroll?.isAnyScrolledRight,
      leftOpenGestureRef,
      motionState,
      openGesturesBlocked,
      position,
      startedRevision,
      touchStartX,
      touchStartY,
      updateGesture,
      windowWidth,
    ],
  );
}

export function useCloseAgentListGesture() {
  const {
    beginGesture,
    finishGesture,
    leftCloseGestureRef,
    motionState,
    position,
    updateGesture,
    windowWidth,
  } = useMobilePanelsRuntime();
  const { startedRevision, touchStartX, touchStartY } = useGestureState();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const commit = useRevisionCommit(showMobileAgent);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(leftCloseGestureRef)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (isMobilePanelGestureCurrent(motionState.value, startedRevision.value)) {
            return;
          }

          const panIntent = resolveMobilePanelGestureIntent({
            deltaX,
            deltaY,
            direction: -1,
            openGesturesBlocked: false,
          });
          if (
            !canBeginMobilePanelGesture(motionState.value, "agent-list", position.value) ||
            panIntent === "fail"
          ) {
            stateManager.fail();
            return;
          }
          if (panIntent === "activate") {
            stateManager.activate();
          }
        })
        .onStart(() => {
          startedRevision.value = beginGesture({
            origin: "agent-list",
            preview: "agent-list",
          });
        })
        .onUpdate((event) => {
          updateGesture(startedRevision.value, -1 - event.translationX / windowWidth);
        })
        .onEnd((event, success) => {
          const shouldClose = event.translationX < -windowWidth / 3 || event.velocityX < -500;
          const result = finishGesture({
            startedRevision: startedRevision.value,
            target: shouldClose ? "agent" : "agent-list",
            success,
          });
          if (result) {
            scheduleOnRN(commit, result.startedRevision);
          }
        }),
    [
      beginGesture,
      commit,
      finishGesture,
      leftCloseGestureRef,
      motionState,
      position,
      startedRevision,
      touchStartX,
      touchStartY,
      updateGesture,
      windowWidth,
    ],
  );

  return { gesture, gestureRef: leftCloseGestureRef };
}

interface OpenFileExplorerGestureOptions {
  enabled: boolean;
  onOpen: () => void;
}

export function useOpenFileExplorerGesture({ enabled, onOpen }: OpenFileExplorerGestureOptions) {
  const {
    beginGesture,
    finishGesture,
    leftOpenGestureRef,
    motionState,
    openGesturesBlocked,
    position,
    rightOpenGestureRef,
    updateGesture,
    windowWidth,
  } = useMobilePanelsRuntime();
  const { startedRevision, touchStartX, touchStartY } = useGestureState();
  const commit = useRevisionCommit(onOpen);

  return useMemo(
    () =>
      Gesture.Pan()
        .withRef(rightOpenGestureRef)
        .simultaneousWithExternalGesture(leftOpenGestureRef)
        .enabled(enabled)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (isMobilePanelGestureCurrent(motionState.value, startedRevision.value)) {
            return;
          }

          const panIntent = resolveMobilePanelGestureIntent({
            deltaX,
            deltaY,
            direction: -1,
            openGesturesBlocked: openGesturesBlocked.value,
          });
          if (
            !canBeginMobilePanelGesture(motionState.value, "agent", position.value) ||
            (isWeb && touchStartX.value < windowWidth - MOBILE_WEB_EDGE_SWIPE_WIDTH) ||
            panIntent === "fail"
          ) {
            stateManager.fail();
            return;
          }
          if (panIntent === "activate") {
            stateManager.activate();
          }
        })
        .onStart(() => {
          startedRevision.value = beginGesture({
            origin: "agent",
            preview: "file-explorer",
          });
        })
        .onUpdate((event) => {
          updateGesture(startedRevision.value, -event.translationX / windowWidth);
        })
        .onEnd((event, success) => {
          const shouldOpen = event.translationX < -windowWidth / 3 || event.velocityX < -500;
          const result = finishGesture({
            startedRevision: startedRevision.value,
            target: shouldOpen ? "file-explorer" : "agent",
            success,
          });
          if (result) {
            scheduleOnRN(commit, result.startedRevision);
          }
        }),
    [
      beginGesture,
      commit,
      enabled,
      finishGesture,
      leftOpenGestureRef,
      motionState,
      openGesturesBlocked,
      position,
      rightOpenGestureRef,
      startedRevision,
      touchStartX,
      touchStartY,
      updateGesture,
      windowWidth,
    ],
  );
}

export function useCloseFileExplorerGesture() {
  const {
    beginGesture,
    finishGesture,
    motionState,
    position,
    rightCloseGestureRef,
    updateGesture,
    windowWidth,
  } = useMobilePanelsRuntime();
  const { startedRevision, touchStartX, touchStartY } = useGestureState();
  const horizontalScroll = useHorizontalScrollOptional();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const commit = useRevisionCommit(showMobileAgent);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(rightCloseGestureRef)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          if (isMobilePanelGestureCurrent(motionState.value, startedRevision.value)) {
            return;
          }

          const panIntent = resolveMobilePanelGestureIntent({
            deltaX,
            deltaY,
            direction: 1,
            openGesturesBlocked: false,
          });
          if (
            !canBeginMobilePanelGesture(motionState.value, "file-explorer", position.value) ||
            horizontalScroll?.activeGestureStartedScrolled.value ||
            panIntent === "fail"
          ) {
            stateManager.fail();
            return;
          }
          if (panIntent === "activate") {
            stateManager.activate();
          }
        })
        .onStart(() => {
          startedRevision.value = beginGesture({
            origin: "file-explorer",
            preview: "file-explorer",
          });
        })
        .onUpdate((event) => {
          updateGesture(startedRevision.value, 1 - event.translationX / windowWidth);
        })
        .onEnd((event, success) => {
          const shouldClose = event.translationX > windowWidth / 3 || event.velocityX > 500;
          const result = finishGesture({
            startedRevision: startedRevision.value,
            target: shouldClose ? "agent" : "file-explorer",
            success,
          });
          if (result) {
            scheduleOnRN(commit, result.startedRevision);
          }
        }),
    [
      beginGesture,
      commit,
      finishGesture,
      horizontalScroll?.activeGestureStartedScrolled,
      motionState,
      position,
      rightCloseGestureRef,
      startedRevision,
      touchStartX,
      touchStartY,
      updateGesture,
      windowWidth,
    ],
  );

  return { gesture, gestureRef: rightCloseGestureRef };
}

export function useFileExplorerCloseGestureRef() {
  return useMobilePanelsRuntime().rightCloseGestureRef;
}

interface UseBackSwipeGestureOptions {
  /**
   * True if the back gesture should be enabled. Caller is responsible for
   * gating to compact layout and to the platform where the OS doesn't
   * provide a system back gesture (i.e. web). The hook still no-ops on
   * native even if `enabled` is true.
   */
  enabled: boolean;
}

/**
 * Swipe-right anywhere in the central area of the screen to navigate back in
 * the route stack. Mirrors the Android 10+ system back gesture, which PWA
 * users don't otherwise have because the browser's back button is hidden in
 * fullscreen PWA mode. The gesture only fires when:
 *
 *   - the platform is web (isWeb),
 *   - both panels are closed (the close-panel gestures own the back swipe
 *     when a panel is open),
 *   - the route stack has somewhere to go back to (router.canGoBack()), and
 *   - the touch starts in the central area, away from the 32px edge zones
 *     reserved for the panel open gestures.
 *
 * Native has its own hardware back button and OS back gesture; this hook is a
 * no-op there.
 */
export function useBackSwipeGesture({ enabled }: UseBackSwipeGestureOptions) {
  const horizontalScroll = useHorizontalScrollOptional();
  const windowWidth = useMobilePanelsRuntime().windowWidth;
  const isAgentListOpen = usePanelStore((s) => s.mobilePanel.target === "agent-list");
  const isFileExplorerOpen = usePanelStore((s) => s.mobilePanel.target === "file-explorer");
  const { touchStartX, touchStartY } = useGestureState();

  const commitBack = useCallback(() => {
    if (!router.canGoBack()) {
      return;
    }
    router.back();
  }, []);

  return useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled && isWeb)
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
            touchStartY.value = touch.absoluteY;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) {
            stateManager.fail();
            return;
          }
          if (isAgentListOpen || isFileExplorerOpen) {
            // Close gestures own horizontal swipes when a panel is open.
            stateManager.fail();
            return;
          }
          if (!router.canGoBack()) {
            stateManager.fail();
            return;
          }
          if (
            touchStartX.value < MOBILE_WEB_BACK_SWIPE_EDGE_BUFFER ||
            touchStartX.value > windowWidth - MOBILE_WEB_BACK_SWIPE_EDGE_BUFFER
          ) {
            // Reserve the edges for the panel open gestures.
            stateManager.fail();
            return;
          }
          const deltaX = touch.absoluteX - touchStartX.value;
          const deltaY = touch.absoluteY - touchStartY.value;
          const absDeltaX = Math.abs(deltaX);
          const absDeltaY = Math.abs(deltaY);
          if (absDeltaY > 10 && absDeltaY > absDeltaX * BACK_SWIPE_VERTICAL_REJECT) {
            // The user is scrolling, not swiping back.
            stateManager.fail();
            return;
          }
          if (horizontalScroll?.activeGestureStartedScrolled.value) {
            stateManager.fail();
            return;
          }
          if (deltaX > 0 && absDeltaX > 10) {
            stateManager.activate();
          }
        })
        .onStart(() => {
          // No-op: the gesture is fully resolved in onEnd.
        })
        .onEnd((event, success) => {
          if (!success) {
            return;
          }
          const activationDistance = windowWidth * BACK_SWIPE_ACTIVATION_RATIO;
          const shouldGoBack = event.translationX > activationDistance;
          if (shouldGoBack) {
            scheduleOnRN(commitBack);
          }
        }),
    [
      commitBack,
      enabled,
      horizontalScroll?.activeGestureStartedScrolled,
      isAgentListOpen,
      isFileExplorerOpen,
      touchStartX,
      touchStartY,
      windowWidth,
    ],
  );
}
