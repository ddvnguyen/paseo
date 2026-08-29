// Apply the UI scale app-wide on web via a CSS variable.
//
// Unistyles theme tokens handle most of the scaling (spacing, icons, fonts,
// borders), but elements outside the theme path (e2e scaffolds, scrollbars,
// data-pmono subtrees) need the scale too. Setting a CSS variable on :root
// allows those to read the value; the zoom property on #root and #overlay-root
// handles the rest. CSS `zoom` is non-standard but widely supported (Chrome
// 119+, Firefox 126+, Safari 18.5+) and the only single-property way to scale
// the entire web UI including borders, paddings, icons, and controls.
const STYLE_ID = "paseo-ui-scale";

export function applyRootUiScale(scale: number): void {
  if (typeof document === "undefined") return;

  document.documentElement.style.setProperty("--paseo-ui-scale", String(scale));

  const RULE = `:is(#root,#overlay-root){zoom:${scale};}`;

  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = RULE;
}
