import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Modal, Platform, Pressable, Text, View } from "react-native";
import type { DimensionValue, StyleProp, ViewStyle } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  getOverlayRoot,
  OverlayLayerProvider,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "../lib/overlay-root";
import {
  BottomSheetBackdrop,
  KEYBOARD_STATUS,
  useBottomSheetInternal,
  type BottomSheetBackgroundProps,
} from "@gorhom/bottom-sheet";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ArrowLeft, Search, X } from "lucide-react-native";
import {
  IsolatedBottomSheetModal,
  type ContextBridge,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import {
  getBottomSheetVisibleContentHeight,
  getCompactSheetSafeAreaPadding,
} from "@/components/adaptive-modal-sheet-layout";
import { ScrollView } from "@/components/ui/scroll-view";
import { isWeb } from "@/constants/platform";
import { SPACING } from "@/styles/theme";
import { useKeyboardVisibility } from "@/hooks/use-keyboard-visibility";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
export { AdaptiveTextInput, type AdaptiveTextInputProps } from "@/components/adaptive-text-input";

// Horizontal indent token shared by the sheet header (title, back arrow,
// leading icon, search input icon) and any row primitive rendered inside the
// sheet body. Rows whose leading icon should line up with the header must
// match this padding.
export const SHEET_HORIZONTAL_PADDING_SCALE = 6;

// The header's close button grows outward from its glyph, so the glyph's
// trailing rail is the content inset plus this padding. Rows whose trailing
// glyph should line up with the X must reach the same rail.
export const SHEET_HEADER_CLOSE_PADDING_SCALE = 2;

/** Glyph size of the edge-to-edge floating close control. */
const FLOATING_CLOSE_GLYPH_SIZE = 16;

/** Padding around that glyph; mirrors theme.spacing[SHEET_HEADER_CLOSE_PADDING_SCALE]. */
const FLOATING_CLOSE_PADDING = 8;

/** Painted box of the floating close: the glyph plus padding on each side. */
const FLOATING_CLOSE_BUTTON_SIZE = FLOATING_CLOSE_GLYPH_SIZE + 2 * FLOATING_CLOSE_PADDING;

/**
 * Takes the painted box up to the 44px minimum touch target without enlarging
 * the button the caller actually sees — the same derived-inset convention the
 * workspace label and terminal profile controls use.
 */
const FLOATING_CLOSE_HIT_SLOP = (44 - FLOATING_CLOSE_BUTTON_SIZE) / 2;

/** Clearance between the floating close and the card's top and right edges. */
const FLOATING_CLOSE_EDGE_INSET_SCALE = 3;

export interface SheetHeaderSearch {
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  resetKey?: string | number;
  placeholder?: string;
  autoFocus?: boolean;
  testID?: string;
}

export interface SheetHeaderBack {
  onPress: () => void;
  label?: string;
  accessibilityLabel?: string;
}

export interface SheetHeader {
  title: string;
  subtitle?: ReactNode;
  back?: SheetHeaderBack;
  leading?: ReactNode;
  actions?: ReactNode;
  search?: SheetHeaderSearch;
}

const SCROLL_CONTENT_GROW = { flexGrow: 1 };
const ABSOLUTE_FILL_STYLE = { ...StyleSheet.absoluteFillObject };

const styles = StyleSheet.create((theme) => ({
  nativeModalRoot: {
    flex: 1,
  },
  desktopOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
    pointerEvents: "auto" as const,
  },
  desktopCard: {
    overflow: "hidden",
    width: "100%",
    maxWidth: 520,
    maxHeight: "85%",
    flexShrink: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  headerContainer: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  headerRow: {
    paddingHorizontal: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    paddingVertical: theme.spacing[4],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerBackButton: {
    borderRadius: theme.borderRadius.lg,
  },
  headerLeadingSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitleGroup: {
    flex: 1,
    gap: theme.spacing[1],
    minWidth: 0,
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  closeButton: {
    padding: theme.spacing[SHEET_HEADER_CLOSE_PADDING_SCALE],
    borderRadius: theme.borderRadius.lg,
  },
  // Edge-to-edge replacement for closeButton, floating over the content because
  // there is no header bar to sit in. It gets an opaque surface fill rather than
  // a translucent one: translucent fills are reserved for interaction states
  // (docs/design.md), and this is a resting surface that has to stay legible
  // over whatever the caller's content paints behind it. Placement is the
  // floatingCloseLayer's job — this is just the painted button.
  floatingClose: {
    padding: FLOATING_CLOSE_PADDING,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  floatingClosePressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    paddingBottom: theme.spacing[3],
  },
  // Inline variants for InlineHeaderView inside the desktop Combobox popover.
  // Horizontal padding matches the model picker's row indent: the picker uses
  // children mode (desktopChildrenScrollContent, no scroll padding), so the
  // row content starts at item.paddingHorizontal = spacing[3].
  // The search row below owns the gap under the title: the input already
  // carries its own vertical padding, so a paddingBottom here would stack on
  // top of two more and push the title far off the field.
  inlineHeaderRow: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inlineSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  inlineTitle: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  searchInput: {
    flex: 1,
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  desktopScrollContainer: {
    // Grows only when the card has an explicit `desktopHeight`; a content-sized
    // card has nothing to grow into. Without it a fixed-height card with short
    // content leaves the footer stranded in the middle.
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    position: "relative",
  },
  desktopScroll: {
    flexShrink: 1,
    minHeight: 0,
  },
  // The sheet's content inset — one definition for every presentation, always
  // applied through <SheetContent />.
  sheetContent: {
    padding: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    gap: theme.spacing[4],
  },
  // Edge-to-edge reset: only zeroes the sheet's own inset, and a caller's own
  // padding still wins because it is applied after this. Scoped to the mode so
  // every other sheet keeps the inset it had.
  edgeToEdgeContent: {
    padding: 0,
  },
  edgeToEdgeOverlay: {
    padding: 0,
  },
  // Positioning layer for the edge-to-edge close control. It spans the card's
  // top edge and lays the button out with padding, so the button needs no
  // offsets of its own. box-none lets touches fall through to the content
  // underneath; zIndex keeps it painted above the body and footer, which are
  // its later siblings and would otherwise cover it. The top padding is added
  // by SheetHeaderView, which owns the safe-area inset.
  floatingCloseLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingRight: theme.spacing[FLOATING_CLOSE_EDGE_INSET_SCALE],
    pointerEvents: "box-none" as const,
  },
  contentGrow: {
    flexGrow: 1,
  },
  compactStaticContent: {
    flex: 1,
    minHeight: 0,
  },
  bottomSheetVisibleContent: {
    minHeight: 0,
    overflow: "hidden",
  },
  bottomSheetVisibleScroll: {
    flex: 1,
    minHeight: 0,
  },
  desktopStaticContent: {
    flexShrink: 1,
    minHeight: 0,
  },
  footer: {
    paddingHorizontal: theme.spacing[SHEET_HORIZONTAL_PADDING_SCALE],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.surface2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
}));

const WEB_EXIT_DURATION_MS = 160;

function SheetBackground({ style }: BottomSheetBackgroundProps) {
  const { theme } = useUnistyles();
  const combinedStyle = useMemo(
    () => [
      style,
      {
        backgroundColor: theme.colors.surface0,
        borderTopLeftRadius: theme.borderRadius["2xl"],
        borderTopRightRadius: theme.borderRadius["2xl"],
      },
    ],
    [style, theme.colors.surface0, theme.borderRadius],
  );
  return <Animated.View pointerEvents="none" style={combinedStyle} />;
}

/**
 * The sheet body, indented to the sheet's content inset.
 *
 * The inset lives on a real `View` and never on a scroller's
 * `contentContainerStyle`: that is a library prop, not the `style` prop
 * Unistyles registers, so a themed inset handed to a third-party scroller such
 * as `BottomSheetScrollView` silently resolves to nothing on web — which is how
 * the compact sheet ended up rendering its cards flush to the screen edges. See
 * docs/unistyles.md "Main Gotcha: contentContainerStyle".
 */
function SheetContent({ style, children }: { style: StyleProp<ViewStyle>; children: ReactNode }) {
  return <View style={[styles.sheetContent, style]}>{children}</View>;
}

function BottomSheetVisibleContent({ children }: { children: ReactNode }) {
  const { animatedDetentsState, animatedKeyboardState, animatedLayoutState, animatedPosition } =
    useBottomSheetInternal();
  const visibleContentStyle = useAnimatedStyle(() => {
    const { containerHeight, handleHeight } = animatedLayoutState.get();
    if (containerHeight < 0 || handleHeight < 0) {
      return { height: 0 };
    }

    const initialDetentPosition = animatedDetentsState.get().detents?.[0];
    const contentPosition =
      initialDetentPosition == null
        ? animatedPosition.get()
        : Math.min(animatedPosition.get(), initialDetentPosition);

    const keyboardState = animatedKeyboardState.get();
    return {
      height: getBottomSheetVisibleContentHeight({
        containerHeight,
        contentPosition,
        handleHeight,
        keyboardHeight: keyboardState.heightWithinContainer,
        isKeyboardVisible: keyboardState.status === KEYBOARD_STATUS.SHOWN,
      }),
    };
  }, [animatedDetentsState, animatedKeyboardState, animatedLayoutState, animatedPosition]);

  return (
    <Animated.View style={[styles.bottomSheetVisibleContent, visibleContentStyle]}>
      {children}
    </Animated.View>
  );
}

/**
 * The sheet header, or — in edge-to-edge mode — the floating close control that
 * replaces it.
 *
 * Edge-to-edge returns the control inside a `box-none` absolute layer instead of
 * the header bar, and drops the bar entirely so the caller's content starts at
 * 0,0. `layerTestID` is how the compact branch keeps its sheet testable: the bar
 * used to carry `testID`, and the desktop branch already carries it on the
 * overlay, so passing it here would duplicate it.
 */
export function SheetHeaderView({
  header,
  onClose,
  showCloseButton = true,
  testID,
  edgeToEdge = false,
  layerTestID,
}: {
  header: SheetHeader;
  onClose: () => void;
  showCloseButton?: boolean;
  testID?: string;
  edgeToEdge?: boolean;
  layerTestID?: string;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const titleStyle = useMemo(
    () => [styles.title, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const back = header.back;
  const handleBackPress = back?.onPress;
  const search = header.search;
  const handleSearchChange = useCallback(
    (value: string) => {
      search?.onChange(value);
    },
    [search],
  );
  // Hoisted so the Pressable does not get a fresh style function every render.
  const floatingCloseStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.floatingClose,
      pressed && styles.floatingClosePressed,
    ],
    [],
  );
  // An edge-to-edge sheet runs full-screen under the status bar on compact, so
  // the control has to take the inset the header bar never did. SPACING is a
  // module constant, so reading it here costs no theme subscription.
  const floatingCloseLayerStyle = useMemo(
    () => [styles.floatingCloseLayer, { paddingTop: insets.top + SPACING[3] }],
    [insets.top],
  );

  if (edgeToEdge) {
    if (!showCloseButton) return null;
    return (
      <View style={floatingCloseLayerStyle} testID={layerTestID}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("common.actions.close")}
          onPress={onClose}
          hitSlop={FLOATING_CLOSE_HIT_SLOP}
          style={floatingCloseStyle}
          testID="sheet-header-close"
        >
          {({ pressed }) => (
            <X
              size={FLOATING_CLOSE_GLYPH_SIZE}
              color={pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
            />
          )}
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.headerContainer} testID={testID}>
      <View style={styles.headerRow}>
        {handleBackPress ? (
          <Pressable
            onPress={handleBackPress}
            hitSlop={8}
            style={styles.headerBackButton}
            accessibilityRole="button"
            accessibilityLabel={back?.accessibilityLabel ?? back?.label ?? t("common.actions.back")}
            testID="sheet-header-back"
          >
            {({ pressed }) => (
              <ArrowLeft
                size={18}
                color={pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        ) : null}
        {header.leading ? <View style={styles.headerLeadingSlot}>{header.leading}</View> : null}
        <View style={styles.headerTitleGroup}>
          <Text style={titleStyle} numberOfLines={1}>
            {header.title}
          </Text>
          {header.subtitle}
        </View>
        {header.actions ? <View style={styles.headerActions}>{header.actions}</View> : null}
        {showCloseButton ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.actions.close")}
            style={styles.closeButton}
            onPress={onClose}
          >
            {({ pressed }) => (
              <X
                size={16}
                color={pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        ) : null}
      </View>
      {search ? (
        <View style={styles.searchRow}>
          <Search size={theme.iconSize.md} color={theme.colors.foregroundMuted} />
          <AdaptiveTextInput
            // @ts-expect-error - outlineStyle is web-only
            style={[styles.searchInput, isWeb && { outlineStyle: "none" }]}
            placeholder={search.placeholder ?? t("common.actions.search")}
            resetKey={search.resetKey}
            onChangeText={handleSearchChange}
            onFocus={search.onFocus}
            onBlur={search.onBlur}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={search.autoFocus}
            testID={search.testID}
          />
        </View>
      ) : null}
    </View>
  );
}

export function InlineHeaderView({ header }: { header: SheetHeader }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const back = header.back;
  const handleBackPress = back?.onPress;
  const hasInlineRow = Boolean(handleBackPress || header.leading || header.actions);
  if (!hasInlineRow && !header.search) return null;
  return (
    <View>
      {hasInlineRow ? (
        <View style={styles.inlineHeaderRow}>
          {handleBackPress ? (
            <Pressable
              onPress={handleBackPress}
              hitSlop={8}
              style={styles.headerBackButton}
              accessibilityRole="button"
              accessibilityLabel={
                back?.accessibilityLabel ?? back?.label ?? t("common.actions.back")
              }
              testID="sheet-header-back"
            >
              {({ pressed }) => (
                <ArrowLeft
                  size={16}
                  color={pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
                />
              )}
            </Pressable>
          ) : null}
          {header.leading ? <View style={styles.headerLeadingSlot}>{header.leading}</View> : null}
          <Text style={styles.inlineTitle} numberOfLines={1}>
            {header.title}
          </Text>
          {header.actions ? <View style={styles.headerActions}>{header.actions}</View> : null}
        </View>
      ) : null}
      {header.search ? (
        <View style={styles.inlineSearchRow}>
          <Search size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
          <AdaptiveTextInput
            // @ts-expect-error - outlineStyle is web-only
            style={[styles.searchInput, isWeb && { outlineStyle: "none" }]}
            placeholder={header.search.placeholder ?? t("common.actions.search")}
            resetKey={header.search.resetKey}
            onChangeText={header.search.onChange}
            onFocus={header.search.onFocus}
            onBlur={header.search.onBlur}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus={header.search.autoFocus}
            testID={header.search.testID}
          />
        </View>
      ) : null}
    </View>
  );
}

export interface AdaptiveModalSheetProps {
  header: SheetHeader;
  visible: boolean;
  onClose: () => void;
  onDismiss?: () => void;
  children: ReactNode;
  /** Sticky footer rendered below the scrollable content. */
  footer?: ReactNode;
  footerContainerStyle?: StyleProp<ViewStyle>;
  snapPoints?: string[];
  testID?: string;
  /** Override the max width of the desktop card. */
  desktopMaxWidth?: number;
  /** Bound an author-owned list without changing content-sized first-party dialogs. */
  desktopHeight?: DimensionValue;
  /** Whether the host supplies the scroll container. Caller-owned lists still share sheet gestures. */
  scrollable?: boolean;
  presentation?: "push" | "replace";
  /** Full body viewport below the header, including space beyond the content. */
  bodyStyle?: StyleProp<ViewStyle>;
  /** Layout intent for the sheet body, composed over the sheet's own content inset. */
  contentStyle?: StyleProp<ViewStyle>;
  /** Size compact sheet content to the live snap height instead of its largest snap point. */
  sizeContentToCurrentSnapPoint?: boolean;
  /** Re-establishes caller-owned contexts inside the compact bottom-sheet portal. */
  contextBridge?: ContextBridge | null;
  /**
   * Render the body flush to the card edges with no header bar: the close
   * control becomes a floating top-right overlay and the sheet's own content
   * inset resets to zero. For callers that draw their own full-bleed surface
   * and already paint their own padding.
   */
  edgeToEdge?: boolean;
  /**
   * The caller's content paints its own close control (a toolbar X, say), so the
   * sheet's own one steps aside — on EVERY form factor, not just wide.
   *
   * The bar is where this control normally lives, so on a non-edge-to-edge sheet
   * the two would simply sit side by side and the caller's would be the one a
   * reader aims at. In `edgeToEdge` there is no bar at all: the control floats
   * over the content, and on compact that means `insets.top + spacing` BELOW the
   * first row of a surface that starts at 0,0. It then lands on whatever the
   * caller painted there — a ledger's column header and timeline strip — which
   * is what a second close control costs when the caller's already covers every
   * state.
   *
   * So the caller's close has to be genuinely always-present before setting this:
   * a fixed row, not one that scrolls away. Absent reads as false, so every
   * existing caller keeps the control it has today.
   */
  surfaceOwnsClose?: boolean;
}

export function AdaptiveModalSheet({
  header,
  visible,
  onClose,
  onDismiss,
  children,
  footer,
  footerContainerStyle,
  snapPoints,
  testID,
  desktopMaxWidth,
  desktopHeight,
  scrollable = true,
  presentation,
  contentStyle,
  bodyStyle,
  sizeContentToCurrentSnapPoint = true,
  contextBridge = null,
  edgeToEdge = false,
  surfaceOwnsClose,
}: AdaptiveModalSheetProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isMobile = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardVisibility(visible);
  const resolvedSnapPoints = useMemo(() => snapPoints ?? ["65%", "90%"], [snapPoints]);
  const compactSafeAreaPadding = useMemo(
    () =>
      getCompactSheetSafeAreaPadding({
        isCompact: isMobile,
        isKeyboardVisible,
        hasFooter: Boolean(footer),
        safeAreaBottom: insets.bottom,
      }),
    [footer, insets.bottom, isKeyboardVisible, isMobile],
  );
  // Safe-area clearance is a separate layer: it must not replace the caller's
  // padding (including an explicit zero), and the footer owns it when present.
  const bodyClearanceStyle = { paddingBottom: compactSafeAreaPadding.contentPaddingBottom ?? 0 };
  const footerClearanceStyle = useMemo(
    () => ({ paddingBottom: compactSafeAreaPadding.footerPaddingBottom ?? 0 }),
    [compactSafeAreaPadding.footerPaddingBottom],
  );
  const footerView = footer ? (
    <View style={footerClearanceStyle}>
      <View style={[styles.footer, footerContainerStyle]}>{footer}</View>
    </View>
  ) : null;
  const handleIndicatorStyle = useMemo(
    () => ({ backgroundColor: theme.colors.palette.zinc[600] }),
    [theme.colors.palette.zinc],
  );
  const { sheetRef, handleSheetChange, handleSheetDismiss } = useIsolatedBottomSheetVisibility({
    visible,
    isEnabled: isMobile,
    onClose,
  });
  const [shouldRenderWeb, setShouldRenderWeb] = useState(visible);
  const [isWebClosing, setIsWebClosing] = useState(false);
  const modalLayer = useGlobalWebOverlayLayer("modal", isWeb && !isMobile && shouldRenderWeb);
  const nativeModalDismissNotifiedRef = useRef(!visible);
  const handleDismiss = useCallback(() => {
    handleSheetDismiss();
    onDismiss?.();
  }, [handleSheetDismiss, onDismiss]);
  const notifyNativeModalDismiss = useCallback(() => {
    if (nativeModalDismissNotifiedRef.current) {
      return;
    }
    nativeModalDismissNotifiedRef.current = true;
    onDismiss?.();
  }, [onDismiss]);

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.45} />
    ),
    [],
  );

  const desktopCardStyle = useMemo(
    () => [
      styles.desktopCard,
      // An explicit height also governs the ceiling, otherwise the card's own
      // maxHeight: "85%" silently clamps a caller asking for more and the sheet
      // never fills the viewport. A caller that passes no height — or the same
      // "85%" the default already was — is byte-identical to before.
      desktopHeight != null && { height: desktopHeight, maxHeight: desktopHeight },
      desktopMaxWidth != null && { maxWidth: desktopMaxWidth },
    ],
    [desktopMaxWidth, desktopHeight],
  );
  const desktopOverlayStyle = useMemo(
    () => [
      styles.desktopOverlay,
      edgeToEdge && styles.edgeToEdgeOverlay,
      isWeb && {
        zIndex: modalLayer,
        opacity: isWebClosing ? 0 : 1,
        transitionDuration: `${WEB_EXIT_DURATION_MS}ms`,
        transitionProperty: "opacity",
        transitionTimingFunction: "ease",
      },
    ],
    [edgeToEdge, isWebClosing, modalLayer],
  );

  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return true;
    },
    [onClose],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: isWeb && !isMobile && visible,
    layer: modalLayer,
    onKeyDown: handleWebOverlayKeyDown,
  });

  useEffect(() => {
    if (visible) {
      nativeModalDismissNotifiedRef.current = false;
    }
  }, [visible]);

  useEffect(() => {
    if (!isWeb || isMobile) return;
    if (visible) {
      setShouldRenderWeb(true);
      setIsWebClosing(false);
      return;
    }
    if (!shouldRenderWeb) return;
    setIsWebClosing(true);
    const timeout = window.setTimeout(() => {
      setShouldRenderWeb(false);
      setIsWebClosing(false);
      onDismiss?.();
    }, WEB_EXIT_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [visible, isMobile, onDismiss, shouldRenderWeb]);

  useEffect(() => {
    if (isWeb || isMobile || visible || Platform.OS !== "android") return;
    const timeout = setTimeout(notifyNativeModalDismiss, 0);
    return () => clearTimeout(timeout);
  }, [visible, isMobile, notifyNativeModalDismiss]);

  const edgeToEdgeContentStyle = useMemo(
    () => (edgeToEdge ? styles.edgeToEdgeContent : undefined),
    [edgeToEdge],
  );
  // A surface that draws its own close does so on EVERY form factor. See
  // `surfaceOwnsClose` for why the compact exception was a mistake.
  const showSheetClose = surfaceOwnsClose !== true;

  if (isMobile) {
    const body = (
      <View style={[styles.compactStaticContent, bodyStyle]}>
        {scrollable ? (
          <ScrollView
            style={styles.bottomSheetVisibleScroll}
            contentContainerStyle={SCROLL_CONTENT_GROW}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={[styles.contentGrow, bodyClearanceStyle]}>
              <SheetContent style={[styles.contentGrow, contentStyle, edgeToEdgeContentStyle]}>
                {children}
              </SheetContent>
            </View>
          </ScrollView>
        ) : (
          <View style={[styles.compactStaticContent, bodyClearanceStyle]}>
            <SheetContent
              style={[styles.compactStaticContent, contentStyle, edgeToEdgeContentStyle]}
            >
              {children}
            </SheetContent>
          </View>
        )}
      </View>
    );
    // In edge-to-edge the bar is gone, so the layer it would have rendered in
    // takes over the compact branch's testID and keeps the sheet queryable.
    const sheetContent = (
      <>
        <SheetHeaderView
          header={header}
          onClose={onClose}
          testID={testID}
          edgeToEdge={edgeToEdge}
          layerTestID={testID}
          showCloseButton={showSheetClose}
        />
        {body}
        {footerView}
      </>
    );

    return (
      <IsolatedBottomSheetModal
        ref={sheetRef}
        contextBridge={contextBridge}
        snapPoints={resolvedSnapPoints}
        index={0}
        enableDynamicSizing={false}
        onChange={handleSheetChange}
        onDismiss={handleDismiss}
        backdropComponent={renderBackdrop}
        enablePanDownToClose
        backgroundComponent={SheetBackground}
        handleIndicatorStyle={handleIndicatorStyle}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        accessible={false}
        presentation={presentation}
      >
        {sizeContentToCurrentSnapPoint ? (
          <BottomSheetVisibleContent>{sheetContent}</BottomSheetVisibleContent>
        ) : (
          sheetContent
        )}
      </IsolatedBottomSheetModal>
    );
  }

  const desktopStaticStyle =
    desktopHeight == null ? styles.desktopStaticContent : styles.compactStaticContent;
  const cardInner = (
    <OverlayLayerProvider layer={modalLayer}>
      <SheetHeaderView
        header={header}
        onClose={onClose}
        edgeToEdge={edgeToEdge}
        showCloseButton={showSheetClose}
      />
      <View style={[scrollable ? styles.desktopScrollContainer : desktopStaticStyle, bodyStyle]}>
        {scrollable ? (
          <ScrollView
            style={styles.desktopScroll}
            contentContainerStyle={SCROLL_CONTENT_GROW}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            <SheetContent style={[styles.contentGrow, contentStyle, edgeToEdgeContentStyle]}>
              {children}
            </SheetContent>
          </ScrollView>
        ) : (
          <SheetContent style={[desktopStaticStyle, contentStyle, edgeToEdgeContentStyle]}>
            {children}
          </SheetContent>
        )}
      </View>
      {footerView}
    </OverlayLayerProvider>
  );

  const desktopContent = (
    <View style={desktopOverlayStyle} testID={testID}>
      <Pressable
        accessibilityLabel={t("common.actions.dismiss")}
        style={ABSOLUTE_FILL_STYLE}
        onPress={onClose}
      />
      <View
        ref={setWebOverlayScope}
        style={desktopCardStyle}
        role="dialog"
        aria-modal
        tabIndex={-1}
      >
        {cardInner}
      </View>
    </View>
  );

  // On web, use portal to overlay root for consistent stacking with toasts
  if (isWeb && typeof document !== "undefined") {
    if (!shouldRenderWeb) return null;
    return createPortal(desktopContent, getOverlayRoot());
  }

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
      onDismiss={notifyNativeModalDismiss}
      hardwareAccelerated
    >
      {/* Android Modal opens a separate window outside the app's gesture root. */}
      <GestureHandlerRootView style={styles.nativeModalRoot}>
        {desktopContent}
      </GestureHandlerRootView>
    </Modal>
  );
}
