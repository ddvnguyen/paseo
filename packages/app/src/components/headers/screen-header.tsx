import { useMemo, type ReactNode } from "react";
import type { LayoutChangeEvent } from "react-native";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";

// Web-only header positioning. Kept out of the Unistyles StyleSheet because
// the library's value schema disallows `position: "sticky"`. Bumping zIndex
// above 5 ensures the header stays on top of agent stream and panels while
// the page scrolls to keep a focused input in view.
const stickyHeaderStyle = {
  position: "sticky" as const,
  top: 0,
  zIndex: 5,
};

interface ScreenHeaderProps {
  left?: ReactNode;
  right?: ReactNode;
  leftStyle?: StyleProp<ViewStyle>;
  rightStyle?: StyleProp<ViewStyle>;
  borderless?: boolean;
  onRowLayout?: (event: LayoutChangeEvent) => void;
}

/**
 * Shared frame for the home/back headers so we only maintain padding, border,
 * and safe-area logic in one place.
 */
export function ScreenHeader({
  left,
  right,
  leftStyle,
  rightStyle,
  borderless,
  onRowLayout,
}: ScreenHeaderProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isMobile = useIsCompactFormFactor();
  // Only add extra padding on mobile for better touch targets; on desktop, only use safe area insets
  const topPadding = isMobile ? HEADER_TOP_PADDING_MOBILE : 0;
  const baseHorizontalPadding = isMobile ? theme.spacing[2] : theme.spacing[3];

  const innerStyle = useMemo(
    () => [styles.inner, { paddingTop: insets.top + topPadding }],
    [insets.top, topPadding],
  );
  const rowStyle = useMemo(() => [styles.row, borderless && styles.borderless], [borderless]);
  const leftCombinedStyle = useMemo(() => [styles.left, leftStyle], [leftStyle]);
  const rightCombinedStyle = useMemo(() => [styles.right, rightStyle], [rightStyle]);
  // On web, pin the header to the top of its scroll container so the browser's
  // native "scroll focused control into view" behavior does not push the
  // header out of the viewport when the user focuses an input. Native iOS
  // already keeps the header visible (useKeyboardShiftStyle translates the
  // composer, not the page), so this only needs to apply on web. The style
  // is inlined because Unistyles' StyleSheet.create type rejects
  // `position: "sticky"` (its value schema only includes absolute/relative/
  // static) and we want to keep this one web-only behavior outside the
  // stylesheet.
  const headerStyle = (
    isWeb ? [styles.header, stickyHeaderStyle] : [styles.header]
  ) as StyleProp<ViewStyle>;

  return (
    <View style={headerStyle}>
      <View style={innerStyle}>
        <WindowChromeSafeArea
          placement="inline"
          horizontalPadding={baseHorizontalPadding}
          onLayout={onRowLayout}
          style={rowStyle}
        >
          <TitlebarDragRegion />
          <View style={leftCombinedStyle}>{left}</View>
          <View style={rightCombinedStyle}>{right}</View>
        </WindowChromeSafeArea>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    backgroundColor: theme.colors.surface0,
  },
  inner: {},
  row: {
    position: "relative",
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  left: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  right: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  borderless: {
    borderBottomColor: "transparent",
  },
}));
