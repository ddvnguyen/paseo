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

  const RULE = `:is(#root,#overlay-root){zoom:${uiScale};}`;

  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = RULE;
}
