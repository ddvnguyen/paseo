import { useMemo, type ComponentProps, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { isWeb } from "@/constants/platform";
import { useSettings } from "@/hooks/use-settings";
import { WindowChromeRootRegion } from "@/utils/desktop-window";
import { usePanelStore, type MobilePanelView } from "@/stores/panel-store";
import { getMobilePanelFrame } from "./model";
import { useIsMobilePanelPresented, useMobilePanelsRuntime } from "./provider";

type OverlayPanel = Exclude<MobilePanelView, "agent">;

interface MobilePanelOverlayProps {
  children: ReactNode;
  closeGesture: GestureType;
  panel: OverlayPanel;
  panelStyle?: ComponentProps<typeof Animated.View>["style"];
}

export function MobilePanelOverlay({
  children,
  closeGesture,
  panel,
  panelStyle,
}: MobilePanelOverlayProps) {
  const { position, windowWidth } = useMobilePanelsRuntime();
  const target = usePanelStore((state) => state.mobilePanel.target);
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const isOpen = target === panel;
  const isPresented = useIsMobilePanelPresented(panel);
  const isLeft = panel === "agent-list";
  const uiScale = useSettings((settings) => settings.uiScale);

  // This overlay lives inside #root's normal React tree (not portaled to
  // #overlay-root), so it renders within the SAME `zoom: uiScale` transform
  // applied to #root (see apply-root-scale.web.ts) rather than getting its
  // own compensation the way #overlay-root does. #root itself is left
  // uncompensated by design — its shrink is invisible there because body's
  // background shows through — but this panel paints a solid surface, so
  // that same shrink leaves a visible gap unless we correct for it here.
  // `windowWidth` from useWindowDimensions() reports the true, un-zoomed
  // viewport, so dividing by uiScale before using it as a *logical* size
  // makes the post-zoom rendered size land back on the true viewport size.
  const compensatedWidth = isWeb && uiScale !== 1 ? windowWidth / uiScale : windowWidth;

  const sidebarAnimatedStyle = useAnimatedStyle(() => {
    const frame = getMobilePanelFrame(position.value, compensatedWidth);
    return {
      transform: [{ translateX: isLeft ? frame.leftTranslateX : frame.rightTranslateX }],
    };
  }, [isLeft, compensatedWidth]);

  const backdropAnimatedStyle = useAnimatedStyle(() => {
    const frame = getMobilePanelFrame(position.value, compensatedWidth);
    return { opacity: isLeft ? frame.leftBackdropOpacity : frame.rightBackdropOpacity };
  }, [isLeft, compensatedWidth]);

  const overlayStyle = useMemo(
    () => [
      styles.overlay,
      isWeb && uiScale !== 1
        ? ({
            width: `${100 / uiScale}%`,
            height: `${100 / uiScale}%`,
          } as ViewStyle)
        : null,
      { display: isPresented ? ("flex" as const) : ("none" as const) },
    ],
    [isPresented, uiScale],
  );
  const positionedPanelStyle = isLeft ? styles.leftPanel : styles.rightPanel;
  const backdropStyle = useMemo(
    () => [styles.backdrop, backdropAnimatedStyle],
    [backdropAnimatedStyle],
  );
  const combinedPanelStyle = useMemo(
    () => [
      styles.panel,
      positionedPanelStyle,
      { width: compensatedWidth },
      panelStyle,
      sidebarAnimatedStyle,
    ],
    [panelStyle, positionedPanelStyle, sidebarAnimatedStyle, compensatedWidth],
  );
  let overlayPointerEvents: "auto" | "box-none" | "none";
  if (!isWeb) {
    overlayPointerEvents = "box-none";
  } else {
    overlayPointerEvents = isOpen ? "auto" : "none";
  }

  return (
    <GestureDetector gesture={closeGesture} touchAction="pan-y">
      {/* Fabric needs an always-mounted native host to attach the close handler while the
          retained panel content is hidden. nativeID keeps that host registered. */}
      <View
        collapsable={false}
        nativeID={`${panel}-gesture-host`}
        pointerEvents={overlayPointerEvents}
        style={styles.overlay}
      >
        <View style={overlayStyle} pointerEvents={overlayPointerEvents}>
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={showMobileAgent}
            pointerEvents={isOpen ? "auto" : "none"}
            style={StyleSheet.absoluteFillObject}
            testID={`${panel}-backdrop`}
          >
            <Animated.View pointerEvents="none" style={backdropStyle} />
          </Pressable>

          <Animated.View pointerEvents={isOpen ? "auto" : "none"} style={combinedPanelStyle}>
            <WindowChromeRootRegion corners="both">{children}</WindowChromeRootRegion>
          </Animated.View>
        </View>
      </View>
    </GestureDetector>
  );
}

// Reanimated owns only these static native styles and the derived transform.
// Theme values stay inline at call sites, avoiding Unistyles patching the same
// native node after Fabric commits.
const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  panel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    overflow: "hidden",
  },
  leftPanel: {
    left: 0,
  },
  rightPanel: {
    right: 0,
  },
});
