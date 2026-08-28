import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Animated, View, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";

const PULL_THRESHOLD = 80;
const MAX_PULL = 140;
const INDICATOR_HEIGHT = 44;

interface PullToRefreshProps {
  refreshing: boolean;
  onRefresh: () => void;
  children: ReactNode;
}

interface ScrollableContext {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  isAtTop(): boolean;
}

function resolveScrollable(target: EventTarget | null): ScrollableContext | null {
  if (!(target instanceof Element)) return null;
  const node = target as Element & {
    scrollTop?: number;
    scrollHeight?: number;
    clientHeight?: number;
  };

  let cursor: Element | null = node;
  while (cursor && cursor !== document.body) {
    const style = window.getComputedStyle(cursor);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      cursor.scrollHeight > cursor.clientHeight
    ) {
      const scrollTop = cursor.scrollTop;
      const scrollHeight = cursor.scrollHeight;
      const clientHeight = cursor.clientHeight;
      return {
        scrollTop,
        scrollHeight,
        clientHeight,
        isAtTop() {
          return cursor!.scrollTop <= 0;
        },
      };
    }
    cursor = cursor.parentElement;
  }
  return null;
}

export function PullToRefresh({ refreshing, onRefresh, children }: PullToRefreshProps) {
  const [pullDistance, setPullDistance] = useState(0);
  const [armed, setArmed] = useState(false);
  const startYRef = useRef<number | null>(null);
  const scrollableRef = useRef<ScrollableContext | null>(null);
  const translateY = useRef(new Animated.Value(0)).current;
  const refreshingRef = useRef(refreshing);
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    refreshingRef.current = refreshing;
  }, [refreshing]);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const animateTo = useCallback(
    (value: number) => {
      Animated.timing(translateY, {
        toValue: value,
        duration: 180,
        useNativeDriver: true,
      }).start();
    },
    [translateY],
  );

  useEffect(() => {
    if (refreshing) {
      animateTo(INDICATOR_HEIGHT);
    } else if (pullDistance === 0) {
      animateTo(0);
    }
  }, [refreshing, pullDistance, animateTo]);

  const handlePointerDown = useCallback((event: React.PointerEvent) => {
    if (refreshingRef.current) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const scrollable = resolveScrollable(event.target);
    if (!scrollable || !scrollable.isAtTop()) {
      scrollableRef.current = null;
      startYRef.current = null;
      return;
    }
    scrollableRef.current = scrollable;
    startYRef.current = event.clientY;
    setPullDistance(0);
    setArmed(false);
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (startYRef.current === null) return;
      const scrollable = scrollableRef.current;
      if (!scrollable) {
        startYRef.current = null;
        return;
      }
      if (!scrollable.isAtTop()) {
        startYRef.current = null;
        setPullDistance(0);
        translateY.setValue(0);
        return;
      }
      const delta = event.clientY - startYRef.current;
      if (delta <= 0) {
        setPullDistance(0);
        translateY.setValue(0);
        return;
      }
      if (!event.cancelable) return;
      event.preventDefault();
      const damped = Math.min(delta * 0.45, MAX_PULL);
      setPullDistance(damped);
      setArmed(damped >= PULL_THRESHOLD);
      translateY.setValue(damped);
    },
    [translateY],
  );

  const release = useCallback(() => {
    const wasArmed = armed;
    startYRef.current = null;
    scrollableRef.current = null;
    setArmed(false);
    if (wasArmed && !refreshingRef.current) {
      onRefreshRef.current();
    } else {
      setPullDistance(0);
      animateTo(0);
    }
  }, [armed, animateTo]);

  const handlePointerUp = useCallback(() => {
    release();
  }, [release]);
  const handlePointerCancel = useCallback(() => {
    release();
  }, [release]);

  const isRefreshing = refreshing || pullDistance > 0;
  const indicatorOpacity = refreshing ? 1 : Math.min(pullDistance / PULL_THRESHOLD, 1);

  const indicatorTransform = useMemo(
    () => [{ translateY: Animated.subtract(translateY, INDICATOR_HEIGHT) }],
    [translateY],
  );
  const contentTransform = useMemo(() => [{ translateY }], [translateY]);

  const childArray = Array.isArray(children) ? children : [children];
  const content = childArray.map((child) => {
    if (isValidElement(child)) {
      return cloneElement(
        child as ReactElement<{
          onPointerDown?: React.PointerEventHandler;
          onPointerMove?: React.PointerEventHandler;
          onPointerUp?: React.PointerEventHandler;
          onPointerCancel?: React.PointerEventHandler;
          style?: ViewStyle;
        }>,
        {
          onPointerDown: handlePointerDown,
          onPointerMove: handlePointerMove,
          onPointerUp: handlePointerUp,
          onPointerCancel: handlePointerCancel,
        },
      );
    }
    return child;
  });

  return (
    <View style={styles.container}>
      <Animated.View
        pointerEvents="none"
        style={[styles.indicator, { opacity: indicatorOpacity, transform: indicatorTransform }]}
      >
        <View style={[styles.spinner, refreshing || armed ? styles.spinnerActive : null]} />
      </Animated.View>
      <Animated.View style={contentTransform}>{content}</Animated.View>
      {isRefreshing ? <View style={styles.placeholder} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  indicator: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: INDICATOR_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  spinner: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: theme.colors.border,
    borderTopColor: theme.colors.primary,
  },
  spinnerActive: {
    borderTopColor: theme.colors.success,
  },
  placeholder: {
    height: 0,
  },
}));
