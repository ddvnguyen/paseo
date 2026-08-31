// Apply the UI scale app-wide on web via CSS variables.
//
// Unistyles theme tokens handle most of the scaling (spacing, icons, fonts,
// borders), but elements outside the theme path (e2e scaffolds, scrollbars,
// data-pmono subtrees) need the scale too. Setting CSS variables on :root
// allows those to read the values; the zoom property on #root and #overlay-root
// handles the rest. CSS `zoom` is non-standard but widely supported (Chrome
// 119+, Firefox 126+, Safari 18.5+) and the only single-property way to scale
// the entire web UI including borders, paddings, icons, and controls.
const STYLE_ID = "paseo-ui-scale";

export function applyRootUiScale(uiScale: number, spacingScale: number): void {
  if (typeof document === "undefined") return;

  document.documentElement.style.setProperty("--paseo-ui-scale", String(uiScale));
  document.documentElement.style.setProperty("--paseo-spacing-scale", String(spacingScale));

  // `zoom` shrinks an element's own rendered box, not just the size of its
  // content. That shrink is invisible on #root (the leftover space just
  // exposes body's matching background), but #overlay-root is
  // `position: fixed; inset: 0` and is where every modal/sheet portals to
  // (see lib/overlay-root.ts) — its shrink leaves a visible gap at the
  // trailing/bottom edge instead of a themed background, so full-screen
  // mobile sheets (e.g. the side menu) stop reaching the screen edges below
  // 100% scale. Inflate its logical width/height by 1/uiScale so the
  // post-zoom rendered box is back to exactly 100% of the viewport; the
  // explicit width/height here win over the inline `inset: 0` per the CSS
  // over-constrained box resolution (left/top from inset stay, right/bottom
  // are recomputed and ignored).
  const overlayCompensation =
    uiScale === 1 ? "" : `#overlay-root{width:${100 / uiScale}%;height:${100 / uiScale}%;}`;

  // The mobile slide-in panels (Changes/Files, agent list — see
  // mobile-panels/presentation.tsx) render inside #root's own tree rather
  // than portaling to #overlay-root, so they inherit #root's zoom instead of
  // needing their own #overlay-root-style percentage fix. Percentages inside
  // an already-zoomed subtree are scale-invariant ratios (they cancel the
  // zoom factor out on their own), so compensating them the #overlay-root
  // way over-corrects — makes the panel wider than the true viewport. The
  // fix here instead is to cancel #root's zoom outright for this subtree by
  // setting an explicit counter-zoom on it (CSS zoom compounds multiplicatively
  // per element, unlike percentages): uiScale * (1/uiScale) = 1, so raw pixel
  // values (like windowWidth from useWindowDimensions()) are correct again
  // with no JS-side compensation needed.
  const gestureHostCounterZoom = uiScale === 1 ? "" : `[id$="-gesture-host"]{zoom:${1 / uiScale};}`;
  const RULE = `:is(#root,#overlay-root){zoom:${uiScale};}${overlayCompensation}${gestureHostCounterZoom}`;

  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = RULE;
}
