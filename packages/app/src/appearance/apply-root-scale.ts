// Native (and default) no-op: React Native has no CSS zoom, so the UI scale
// applies only through Unistyles theme tokens patched in applyAppearance.
// The web build (apply-root-scale.web.ts) overrides this to set a CSS variable
// so non-Unistyles DOM elements also follow the scale.
export function applyRootUiScale(_scale: number): void {}
