import { useEffect } from "react";
import { useSharedValue, type SharedValue } from "react-native-reanimated";
import { isWeb } from "@/constants/platform";

/**
 * Tracks `window.visualViewport.offsetTop`.
 *
 * This app pins `html, body, #root` to `overflow: hidden` (see
 * public/index.html) so the layout viewport never scrolls. When Android
 * Chrome or mobile Safari pans the visual viewport to bring a focused input
 * above the software keyboard, content pinned to the layout viewport's top —
 * including a `position: sticky` header, which only tracks an ancestor's
 * actual `scrollTop` — does not move with it and ends up above the now-panned
 * visible area. `offsetTop` is exactly that gap, so a consumer can
 * counter-translate by this amount to stay on screen.
 *
 * No-ops (stays 0) off web and on browsers without `visualViewport` support.
 */
export function useVisualViewportOffsetTop(): SharedValue<number> {
  const offsetTop = useSharedValue(0);

  useEffect(() => {
    if (!isWeb) return;
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      offsetTop.value = vv.offsetTop;
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [offsetTop]);

  return offsetTop;
}
