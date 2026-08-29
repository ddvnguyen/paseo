import { beforeEach, describe, expect, it, vi } from "vitest";
import { darkHighlightColors, resolveSyntaxColors } from "@getpaseo/highlight";
import {
  BORDER_RADIUS,
  BORDER_WIDTH,
  DEFAULT_UI_FONT_STACK,
  ICON_SIZE,
  REGISTERED_THEMES,
  SPACING,
} from "@/styles/theme";
import { applyAppearance, type AppearanceInput } from "./apply";

// Override the global react-native-unistyles mock (vitest.setup.ts) so that
// UnistylesRuntime.updateTheme is a spy that records (themeName, updater) calls.
const { runtime, updateTheme } = vi.hoisted(() => {
  const updateThemeSpy = vi.fn();
  return {
    runtime: { themeName: undefined as string | undefined, updateTheme: updateThemeSpy },
    updateTheme: updateThemeSpy,
  };
});
vi.mock("react-native-unistyles", () => ({ UnistylesRuntime: runtime }));

const ALL_THEME_KEYS = Object.keys(REGISTERED_THEMES);

// The signature of the updater passed to UnistylesRuntime.updateTheme.
type ThemeUpdater = (theme: FakeTheme) => FakeTheme;

// The subset of the theme shape the updater reads / spreads. The real Theme type
// is a frozen `as const` literal; the updater only touches these fields. Casting a
// fake of this shape through `unknown` to ThemeUpdater's param is test-only.
interface FakeTheme {
  colorScheme: "light" | "dark";
  fontFamily: { ui: string; mono: string };
  fontSize: {
    code: number;
    content: number;
    sm: number;
    base: number;
    lg: number;
    xl: number;
    "2xl": number;
    "3xl": number;
    "4xl": number;
  };
  lineHeight: { content: number; diff: number };
  spacing: Record<keyof typeof SPACING, number>;
  iconSize: Record<keyof typeof ICON_SIZE, number>;
  borderRadius: Record<keyof typeof BORDER_RADIUS, number>;
  borderWidth: Record<keyof typeof BORDER_WIDTH, number>;
  colors: { foreground: string; syntax: Record<string, string> };
}

function makeFakeTheme(): FakeTheme {
  return {
    colorScheme: "dark",
    fontFamily: { ui: "seed-ui-stack", mono: "seed-mono-stack" },
    fontSize: {
      code: 12,
      content: 15,
      sm: 12,
      base: 14,
      lg: 16,
      xl: 18,
      "2xl": 20,
      "3xl": 22,
      "4xl": 26,
    },
    lineHeight: { content: 20, diff: 22 },
    spacing: { ...SPACING },
    iconSize: { ...ICON_SIZE },
    borderRadius: { ...BORDER_RADIUS },
    borderWidth: { ...BORDER_WIDTH },
    colors: { foreground: "#fff", syntax: {} },
  };
}

function makeInput(overrides: Partial<AppearanceInput> = {}): AppearanceInput {
  return {
    uiFontFamily: "",
    monoFontFamily: "",
    uiBaseFontSize: 14,
    contentFontSize: 15,
    codeFontSize: 12,
    uiScale: 1,
    lineHeightScale: 1.3,
    syntaxTheme: "one",
    ...overrides,
  };
}

// Run a single captured updater (default the first) against a fresh fake theme.
function runCapturedUpdater(call = 0): FakeTheme {
  const updater = updateTheme.mock.calls[call]?.[1] as unknown as ThemeUpdater;
  return updater(makeFakeTheme());
}

describe("applyAppearance", () => {
  beforeEach(() => {
    updateTheme.mockClear();
    runtime.themeName = undefined;
  });

  it("patches every registered Unistyles theme exactly once", () => {
    applyAppearance(makeInput());

    expect(updateTheme).toHaveBeenCalledTimes(ALL_THEME_KEYS.length);
    expect(updateTheme.mock.calls.map((call) => call[0])).toEqual([...ALL_THEME_KEYS]);
  });

  it("patches the active theme before inactive registry entries", () => {
    runtime.themeName = "darkPureBlack";

    applyAppearance(makeInput({ uiBaseFontSize: 15 }));

    expect(updateTheme.mock.calls.map((call) => call[0])).toEqual([
      "darkPureBlack",
      ...ALL_THEME_KEYS.filter((key) => key !== "darkPureBlack"),
    ]);
  });

  it("resolves an empty UI font family to the default stack", () => {
    applyAppearance(makeInput({ uiFontFamily: "" }));

    expect(runCapturedUpdater().fontFamily.ui).toBe(DEFAULT_UI_FONT_STACK);
  });

  it("passes a non-empty UI font family through trimmed", () => {
    applyAppearance(makeInput({ uiFontFamily: "  Menlo  " }));

    expect(runCapturedUpdater().fontFamily.ui).toBe("Menlo");
  });

  it("scales the whole UI ramp proportionally while preserving ratios", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 15 }));

    const { fontSize } = runCapturedUpdater();
    expect(fontSize.base).toBe(15);
    expect(fontSize.sm).toBe(13);
    expect(fontSize.lg).toBe(17);
    expect(fontSize.xl).toBe(19);
    expect(fontSize["4xl"]).toBe(28);
  });

  it("derives the UI ramp from the canonical sizes, not the live theme (no compounding)", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 15 }));

    // Simulate a theme whose fontSize was already scaled by a prior apply; the
    // updater must ignore it and rebuild from the authored FONT_SIZE ramp.
    const updater = updateTheme.mock.calls[0]?.[1] as unknown as ThemeUpdater;
    const alreadyScaled = makeFakeTheme();
    alreadyScaled.fontSize = {
      code: 4,
      content: 4,
      sm: 4,
      base: 4,
      lg: 4,
      xl: 4,
      "2xl": 4,
      "3xl": 4,
      "4xl": 4,
    };

    const { fontSize } = updater(alreadyScaled);
    expect(fontSize.base).toBe(15); // rebuilt from FONT_SIZE, not the live value of 4
    expect(fontSize.lg).toBe(17);
  });

  it("leaves the UI ramp at authored sizes when only the code size changes", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 14, codeFontSize: 10 }));

    const { fontSize } = runCapturedUpdater();
    expect(fontSize.base).toBe(14);
    expect(fontSize.lg).toBe(16);
    expect(fontSize.sm).toBe(12);
    expect(fontSize.code).toBe(10);
  });

  it("sets content size independently of the interface and code sizes", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 14, contentFontSize: 19, codeFontSize: 10 }));

    const { fontSize } = runCapturedUpdater();
    expect(fontSize.base).toBe(14);
    expect(fontSize.content).toBe(19);
    expect(fontSize.code).toBe(10);
  });

  it("sets fontSize.code to codeFontSize regardless of the UI font size", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 14, codeFontSize: 18 }));

    expect(runCapturedUpdater().fontSize.code).toBe(18);
  });

  it("couples lineHeight.diff to the code font size", () => {
    applyAppearance(makeInput({ codeFontSize: 18 }));

    expect(runCapturedUpdater().lineHeight.diff).toBe(Math.round(18 * 1.5)); // 27
  });

  it("swaps colors.syntax to the resolved palette for the named theme", () => {
    applyAppearance(makeInput({ syntaxTheme: "dracula" }));

    const { colors } = runCapturedUpdater();
    expect(colors.syntax).toEqual(resolveSyntaxColors("dracula", "dark"));
  });

  it("resolves a syntax theme using the theme's own color scheme", () => {
    applyAppearance(makeInput({ syntaxTheme: "github" }));

    // makeFakeTheme().colorScheme === "dark" -> github resolves to the dark palette.
    expect(runCapturedUpdater().colors.syntax).toEqual(darkHighlightColors);
    expect(runCapturedUpdater().colors.syntax).toEqual(resolveSyntaxColors("github", "dark"));
  });

  it("scales spacing, icons, and borders by uiScale", () => {
    applyAppearance(makeInput({ uiScale: 1.2 }));

    const result = runCapturedUpdater();
    expect(result.spacing[4]).toBe(Math.round(SPACING[4] * 1.2)); // 19
    expect(result.iconSize.md).toBe(Math.round(ICON_SIZE.md * 1.2)); // 19
    expect(result.borderRadius.lg).toBe(Math.round(BORDER_RADIUS.lg * 1.2)); // 10
    expect(result.borderWidth[1]).toBe(Math.round(BORDER_WIDTH[1] * 1.2)); // 1
  });

  it("leaves borderRadius.full at 9999 regardless of uiScale", () => {
    applyAppearance(makeInput({ uiScale: 0.5 }));

    expect(runCapturedUpdater().borderRadius.full).toBe(9999);
  });

  it("leaves spacing[0] and borderWidth[0] at 0 regardless of uiScale", () => {
    applyAppearance(makeInput({ uiScale: 1.5 }));

    const result = runCapturedUpdater();
    expect(result.spacing[0]).toBe(0);
    expect(result.borderWidth[0]).toBe(0);
  });

  it("uiScale 1.0 leaves all tokens at authored values", () => {
    applyAppearance(makeInput({ uiScale: 1.0 }));

    const result = runCapturedUpdater();
    expect(result.spacing[4]).toBe(SPACING[4]);
    expect(result.iconSize.md).toBe(ICON_SIZE.md);
    expect(result.borderRadius.lg).toBe(BORDER_RADIUS.lg);
    expect(result.borderWidth[1]).toBe(BORDER_WIDTH[1]);
  });

  it("uiScale multiplies UI font ramp but leaves content and code untouched", () => {
    applyAppearance(makeInput({ uiBaseFontSize: 14, uiScale: 1.2 }));

    const result = runCapturedUpdater();
    expect(result.fontSize.base).toBe(Math.round(14 * 1.2)); // 17
    expect(result.fontSize.sm).toBe(Math.round(12 * 1.2)); // 14
    expect(result.fontSize.lg).toBe(Math.round(16 * 1.2)); // 19
    expect(result.fontSize["4xl"]).toBe(Math.round(26 * 1.2)); // 31
    expect(result.fontSize.content).toBe(15); // unchanged
    expect(result.fontSize.code).toBe(12); // unchanged
  });

  it("derives lineHeight.content from contentFontSize * lineHeightScale", () => {
    applyAppearance(makeInput({ contentFontSize: 15, lineHeightScale: 1.4 }));

    expect(runCapturedUpdater().lineHeight.content).toBe(Math.round(15 * 1.4)); // 21
  });

  it("lineHeight.diff is unchanged by lineHeightScale (still codeFontSize * 1.5)", () => {
    applyAppearance(makeInput({ codeFontSize: 18, lineHeightScale: 1.1 }));

    expect(runCapturedUpdater().lineHeight.diff).toBe(Math.round(18 * 1.5)); // 27
  });

  it("applyAppearance is idempotent for uiScale (no compounding)", () => {
    applyAppearance(makeInput({ uiScale: 1.2 }));
    const first = runCapturedUpdater(0);
    applyAppearance(makeInput({ uiScale: 1.2 }));
    const second = runCapturedUpdater(ALL_THEME_KEYS.length);

    expect(second.spacing[4]).toBe(first.spacing[4]);
    expect(second.iconSize.md).toBe(first.iconSize.md);
  });
});
