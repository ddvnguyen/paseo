import { UnistylesRuntime } from "react-native-unistyles";
import { resolveSyntaxColors, type SyntaxThemeId } from "@getpaseo/highlight";
import {
  BORDER_RADIUS,
  BORDER_WIDTH,
  DEFAULT_UI_FONT_STACK,
  DEFAULT_MONO_FONT_STACK,
  FONT_SIZE,
  ICON_SIZE,
  REGISTERED_THEMES,
  SPACING,
  type Theme,
} from "@/styles/theme";
import { applyRootUiFont } from "./apply-root-font";
import { applyRootUiScale } from "./apply-root-scale";

const ALL_THEME_KEYS = Object.keys(REGISTERED_THEMES) as (keyof typeof REGISTERED_THEMES)[];

export interface AppearanceInput {
  uiFontFamily: string; // "" -> default stack
  monoFontFamily: string; // "" -> default stack
  uiBaseFontSize: number; // already clamped
  contentFontSize: number; // already clamped
  codeFontSize: number; // already clamped
  uiScale: number; // 0.75–1.50, default 1 — scales fonts, icons, borders (NOT spacing)
  spacingScale: number; // 0.5–2.0, default 1 — scales spacing tokens only
  lineHeightScale: number; // 0.5–2.0, default 1.3
  syntaxTheme: SyntaxThemeId;
}

/**
 * Build the font-size ramp from the canonical `FONT_SIZE` ramp, scaled
 * proportionally from the requested base size so the type hierarchy is preserved.
 * `uiScale` multiplies the UI font ramp (sm–4xl) so UI zoom affects button
 * labels, headers, and controls. `content` and `code` are absolute — unaffected
 * by uiScale so body text and diffs stay at the user's chosen sizes.
 */
function scaleFontSize(
  uiBaseSize: number,
  contentSize: number,
  codeSize: number,
  uiScale: number,
): Theme["fontSize"] {
  const r = uiBaseSize / FONT_SIZE.base;
  const s = uiScale;
  return {
    sm: Math.round(FONT_SIZE.sm * r * s),
    base: Math.round(FONT_SIZE.base * r * s),
    lg: Math.round(FONT_SIZE.lg * r * s),
    xl: Math.round(FONT_SIZE.xl * r * s),
    "2xl": Math.round(FONT_SIZE["2xl"] * r * s),
    "3xl": Math.round(FONT_SIZE["3xl"] * r * s),
    "4xl": Math.round(FONT_SIZE["4xl"] * r * s),
    content: contentSize, // absolute, NOT scaled
    code: codeSize, // absolute, NOT scaled
  };
}

/**
 * Scale spacing tokens from their canonical constants by `spacingScale`.
 * Idempotent: derives from the authored ramp, never compounds.
 */
function scaleSpacingTokens(scale: number): Theme["spacing"] {
  const round = (v: number) => Math.round(v * scale);
  return {
    0: 0,
    0.5: round(SPACING[0.5]),
    1: round(SPACING[1]),
    1.5: round(SPACING[1.5]),
    2: round(SPACING[2]),
    3: round(SPACING[3]),
    4: round(SPACING[4]),
    6: round(SPACING[6]),
    8: round(SPACING[8]),
    12: round(SPACING[12]),
    16: round(SPACING[16]),
    20: round(SPACING[20]),
    24: round(SPACING[24]),
    32: round(SPACING[32]),
  };
}

/**
 * Scale non-font, non-spacing design tokens (icons, borders) from their
 * canonical constants by `uiScale`. Idempotent: derives from the authored
 * ramp, never compounds.
 *
 * `borderRadius.full` is left at its authored 9999 (pill shape), not scaled.
 */
function scaleUiTokens(scale: number): {
  iconSize: Theme["iconSize"];
  borderRadius: Theme["borderRadius"];
  borderWidth: Theme["borderWidth"];
} {
  const round = (v: number) => Math.round(v * scale);
  return {
    iconSize: {
      xs: round(ICON_SIZE.xs),
      sm: round(ICON_SIZE.sm),
      md: round(ICON_SIZE.md),
      lg: round(ICON_SIZE.lg),
    },
    borderRadius: {
      none: 0,
      sm: round(BORDER_RADIUS.sm),
      base: round(BORDER_RADIUS.base),
      md: round(BORDER_RADIUS.md),
      lg: round(BORDER_RADIUS.lg),
      xl: round(BORDER_RADIUS.xl),
      "2xl": round(BORDER_RADIUS["2xl"]),
      full: BORDER_RADIUS.full,
    },
    borderWidth: {
      0: 0,
      1: round(BORDER_WIDTH[1]),
      2: round(BORDER_WIDTH[2]),
    },
  };
}

/**
 * Patch every registered Unistyles theme with the user's appearance choices.
 * All keys in `ALL_THEME_KEYS` are patched because the active theme can change
 * and adaptive mode can flip light/dark — patching all keys keeps the active key
 * always current and makes ordering vs `setTheme`/`setAdaptiveThemes` irrelevant.
 *
 * The updater preserves the active theme wholesale (surfaces, accents,
 * terminal) and only patches the font ramp, UI tokens, and syntax palette.
 * `updateTheme` replaces the stored theme rather than merging, so we spread
 * `...t` first.
 */
export function applyAppearance(input: AppearanceInput): void {
  const ui = input.uiFontFamily.trim() || DEFAULT_UI_FONT_STACK;
  const mono = input.monoFontFamily.trim() || DEFAULT_MONO_FONT_STACK;
  const diffLineHeight = Math.round(input.codeFontSize * 1.5); // couple to code size
  const contentLineHeight = Math.round(input.contentFontSize * input.lineHeightScale);
  const uiTokens = scaleUiTokens(input.uiScale);
  const spacing = scaleSpacingTokens(input.spacingScale);
  const activeTheme = UnistylesRuntime.themeName;
  // Unistyles web emits after each registry patch. Updating the mounted theme
  // first ensures subscribers receive its new numeric tokens in this render;
  // updating it last makes Pure black appear one committed value behind.
  const themeKeys = activeTheme
    ? [activeTheme, ...ALL_THEME_KEYS.filter((key) => key !== activeTheme)]
    : ALL_THEME_KEYS;

  for (const key of themeKeys) {
    UnistylesRuntime.updateTheme(key, (t) => {
      const fontFamily = { ui, mono };
      const fontSize = scaleFontSize(
        input.uiBaseFontSize,
        input.contentFontSize,
        input.codeFontSize,
        input.uiScale,
      );
      const lineHeight = { ...t.lineHeight, content: contentLineHeight, diff: diffLineHeight };
      if (t.colorScheme === "light") {
        return {
          ...t,
          fontFamily,
          fontSize,
          lineHeight,
          spacing,
          ...uiTokens,
          colors: { ...t.colors, syntax: resolveSyntaxColors(input.syntaxTheme, t.colorScheme) },
        };
      }
      return {
        ...t,
        fontFamily,
        fontSize,
        lineHeight,
        spacing,
        ...uiTokens,
        colors: { ...t.colors, syntax: resolveSyntaxColors(input.syntaxTheme, t.colorScheme) },
      };
    });
  }

  // Web: apply the UI font app-wide (RN-web stamps a default font on every text
  // element, so it can't be done through the theme alone). No-op on native.
  applyRootUiFont(ui);
  // Web-only: set CSS variables so non-Unistyles DOM follows the scales.
  applyRootUiScale(input.uiScale, input.spacingScale);
}
