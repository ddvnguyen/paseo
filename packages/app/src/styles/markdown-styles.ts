import { FONT_SIZE, type Theme } from "./theme";
import { isWeb } from "@/constants/platform";

const webSelectableTextStyle = isWeb ? { userSelect: "text" as const } : {};

function contentHeadingSize(contentSize: number, tier: keyof typeof FONT_SIZE): number {
  return Math.round(contentSize * (FONT_SIZE[tier] / FONT_SIZE.base));
}

function contentHeadingLineHeight(contentSize: number, tier: keyof typeof FONT_SIZE): number {
  return Math.round(contentHeadingSize(contentSize, tier) * 1.3);
}

/**
 * Compact spacing helper: multiplies spacing values by the theme's
 * `contentSpacingScale` so markdown element spacing is independently
 * adjustable (50%–200%, default 75%). The scale applies on top of the
 * global `spacingScale` which already multiplies `theme.spacing[]`.
 */
export function getContentSpacing(theme: Theme, token: number): number {
  return Math.round(token * (theme.contentSpacingScale ?? 0.75));
}

function cs(theme: Theme, token: number): number {
  return getContentSpacing(theme, token);
}

function debugSpacingBg(theme: Theme): Record<string, string> {
  return theme.debugConversationSpacing ? { backgroundColor: "rgba(255,0,0,0.18)" } : {};
}

/**
 * Creates comprehensive markdown styles for react-native-markdown-display.
 *
 * Usage:
 *   const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);
 *   <Markdown style={markdownStyles} markdownit={parser}>{content}</Markdown>
 *
 * Always pass `markdownit` from `@/utils/markdown-parser`. Omit it and
 * react-native-markdown-display builds its own parser with `typographer: true`,
 * which rewrites a literal `(c)` as ©.
 */
export function createMarkdownStyles(theme: Theme) {
  return {
    // =========================================================================
    // BASE STYLES
    // =========================================================================

    body: {
      ...webSelectableTextStyle,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.content,
      // Prose line-height scales with the content size, not the
      // code-size-coupled lineHeight.diff token used by code/diff surfaces.
      lineHeight: Math.round(theme.fontSize.content * 1.4),
      flexShrink: 1,
      minWidth: 0,
      width: "100%" as const,
    },

    text: {
      ...webSelectableTextStyle,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
    },

    paragraph: {
      marginTop: 0,
      marginBottom: cs(theme, theme.spacing[3]),
      ...debugSpacingBg(theme),
      flexWrap: "wrap" as const,
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      justifyContent: "flex-start" as const,
      flexShrink: 1,
      minWidth: 0,
      width: "100%" as const,
    },

    // =========================================================================
    // HEADINGS
    // =========================================================================

    heading1: {
      ...webSelectableTextStyle,
      ...debugSpacingBg(theme),
      fontSize: contentHeadingSize(theme.fontSize.content, "4xl"),
      fontWeight: theme.fontWeight.bold,
      color: theme.colors.foreground,
      marginTop: cs(theme, theme.spacing[6]),
      marginBottom: cs(theme, theme.spacing[3]),
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "4xl"),
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: cs(theme, theme.spacing[2]),
    },

    heading2: {
      ...webSelectableTextStyle,
      ...debugSpacingBg(theme),
      fontSize: contentHeadingSize(theme.fontSize.content, "3xl"),
      fontWeight: theme.fontWeight.bold,
      color: theme.colors.foreground,
      marginTop: cs(theme, theme.spacing[6]),
      marginBottom: cs(theme, theme.spacing[3]),
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "3xl"),
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: cs(theme, theme.spacing[2]),
    },

    heading3: {
      ...webSelectableTextStyle,
      ...debugSpacingBg(theme),
      fontSize: contentHeadingSize(theme.fontSize.content, "2xl"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: cs(theme, theme.spacing[4]),
      marginBottom: cs(theme, theme.spacing[2]),
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "2xl"),
    },

    heading4: {
      ...webSelectableTextStyle,
      ...debugSpacingBg(theme),
      fontSize: contentHeadingSize(theme.fontSize.content, "xl"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: cs(theme, theme.spacing[4]),
      marginBottom: cs(theme, theme.spacing[2]),
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "xl"),
    },

    heading5: {
      ...webSelectableTextStyle,
      ...debugSpacingBg(theme),
      fontSize: contentHeadingSize(theme.fontSize.content, "lg"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: cs(theme, theme.spacing[3]),
      marginBottom: cs(theme, theme.spacing[1]),
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "lg"),
    },

    heading6: {
      ...webSelectableTextStyle,
      ...debugSpacingBg(theme),
      fontSize: contentHeadingSize(theme.fontSize.content, "lg"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foregroundMuted,
      marginTop: cs(theme, theme.spacing[3]),
      marginBottom: cs(theme, theme.spacing[1]),
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "lg"),
      textTransform: "uppercase" as const,
      letterSpacing: 0.5,
    },

    // =========================================================================
    // TEXT FORMATTING
    // =========================================================================

    strong: {
      ...webSelectableTextStyle,
      fontWeight: theme.fontWeight.medium,
    },

    em: {
      ...webSelectableTextStyle,
      fontStyle: "italic" as const,
    },

    s: {
      ...webSelectableTextStyle,
      textDecorationLine: "line-through" as const,
      color: theme.colors.foregroundMuted,
    },

    link: {
      ...webSelectableTextStyle,
      color: theme.colors.accentBright,
      textDecorationLine: "none" as const,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
    },

    blocklink: {
      ...webSelectableTextStyle,
      color: theme.colors.accentBright,
      textDecorationLine: "none" as const,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
    },

    // =========================================================================
    // CODE
    // =========================================================================

    code_inline: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      paddingHorizontal: theme.spacing[1],
      paddingVertical: 2,
      borderRadius: theme.borderRadius.md,
      borderWidth: 0,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
    },

    code_block: {
      ...webSelectableTextStyle,
      ...(theme.debugConversationSpacing
        ? { backgroundColor: "rgba(255,0,0,0.22)" }
        : { backgroundColor: theme.colors.surface2 }),
      color: theme.colors.foreground,
      padding: cs(theme, theme.spacing[3]),
      borderRadius: theme.borderRadius.md,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      marginVertical: cs(theme, theme.spacing[2]),
    },

    fence: {
      ...webSelectableTextStyle,
      ...(theme.debugConversationSpacing
        ? { backgroundColor: "rgba(255,0,0,0.22)" }
        : { backgroundColor: theme.colors.surface2 }),
      color: theme.colors.foreground,
      padding: cs(theme, theme.spacing[3]),
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      marginVertical: cs(theme, theme.spacing[3]),
    },

    pre: {
      marginVertical: cs(theme, theme.spacing[2]),
    },

    // =========================================================================
    // TABLES
    // =========================================================================

    table: {
      ...debugSpacingBg(theme),
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.md,
      marginVertical: cs(theme, theme.spacing[3]),
    },

    thead: {
      backgroundColor: theme.colors.surface2,
    },

    tbody: {},

    th: {
      ...webSelectableTextStyle,
      padding: cs(theme, theme.spacing[2]),
      borderBottomWidth: 1,
      borderRightWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.content,
      textAlign: "left" as const,
    },

    tr: {
      borderBottomWidth: 1,
      borderColor: theme.colors.border,
      flexDirection: "row" as const,
    },

    td: {
      ...webSelectableTextStyle,
      padding: cs(theme, theme.spacing[2]),
      borderRightWidth: 1,
      borderColor: theme.colors.border,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.content,
      flex: 1,
    },

    // =========================================================================
    // LISTS
    // =========================================================================

    bullet_list: {
      paddingLeft: 0,
      width: "100%" as const,
    },

    ordered_list: {
      paddingLeft: 0,
      width: "100%" as const,
    },

    list_item: {
      ...debugSpacingBg(theme),
      marginBottom: cs(theme, theme.spacing[1]),
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      flexShrink: 1,
    },

    bullet_list_content: {
      flex: 1,
      flexShrink: 1,
    },

    ordered_list_content: {
      flex: 1,
      flexShrink: 1,
    },

    bullet_list_icon: {
      ...webSelectableTextStyle,
      color: theme.colors.foregroundMuted,
      marginRight: theme.spacing[1],
      fontSize: theme.fontSize.content,
      lineHeight: Math.round(theme.fontSize.content * 1.4),
    },

    ordered_list_icon: {
      ...webSelectableTextStyle,
      color: theme.colors.foregroundMuted,
      marginRight: theme.spacing[1],
      fontSize: theme.fontSize.content,
      fontWeight: theme.fontWeight.normal,
      lineHeight: Math.round(theme.fontSize.content * 1.4),
      minWidth: 12,
    },

    // =========================================================================
    // BLOCKQUOTE
    // =========================================================================

    blockquote: {
      ...(theme.debugConversationSpacing
        ? { backgroundColor: "rgba(255,0,0,0.18)" }
        : { backgroundColor: theme.colors.surface1 }),
      color: `${theme.colors.foreground}cc`,
      borderLeftWidth: 4,
      borderLeftColor: theme.colors.surface2,
      paddingHorizontal: cs(theme, theme.spacing[4]),
      paddingTop: cs(theme, theme.spacing[3]),
      paddingBottom: 0,
      marginVertical: cs(theme, theme.spacing[3]),
      borderRadius: theme.borderRadius.md,
      borderTopLeftRadius: 0,
      borderBottomLeftRadius: 0,
    },

    // =========================================================================
    // HORIZONTAL RULE
    // =========================================================================

    hr: {
      ...(theme.debugConversationSpacing
        ? { backgroundColor: "rgba(255,0,0,0.9)" }
        : { backgroundColor: theme.colors.border }),
      height: 1,
      marginVertical: cs(theme, theme.spacing[2]),
    },

    // =========================================================================
    // IMAGES
    // =========================================================================

    image: {
      ...debugSpacingBg(theme),
      borderRadius: theme.borderRadius.md,
      marginVertical: cs(theme, theme.spacing[2]),
    },

    // =========================================================================
    // BREAKS
    // =========================================================================

    hardbreak: {
      ...debugSpacingBg(theme),
      height: cs(theme, theme.spacing[2]),
    },

    softbreak: {},
  };
}

/**
 * Creates a smaller variant of markdown styles for compact UI elements
 * like thought bubbles, tooltips, or side panels.
 */
export function createCompactMarkdownStyles(theme: Theme) {
  const baseStyles = createMarkdownStyles(theme);

  return {
    ...baseStyles,

    body: {
      ...baseStyles.body,
      fontSize: theme.fontSize.content,
      lineHeight: Math.round(theme.fontSize.content * 1.4),
    },

    heading1: {
      ...baseStyles.heading1,
      ...debugSpacingBg(theme),
      fontSize: contentHeadingSize(theme.fontSize.content, "2xl"),
      marginTop: cs(theme, theme.spacing[4]),
      marginBottom: cs(theme, theme.spacing[2]),
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "2xl"),
    },

    heading2: {
      ...baseStyles.heading2,
      ...debugSpacingBg(theme),
      fontSize: contentHeadingSize(theme.fontSize.content, "xl"),
      marginTop: cs(theme, theme.spacing[3]),
      marginBottom: cs(theme, theme.spacing[2]),
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "xl"),
    },

    heading3: {
      ...baseStyles.heading3,
      ...debugSpacingBg(theme),
      fontSize: contentHeadingSize(theme.fontSize.content, "lg"),
      marginTop: cs(theme, theme.spacing[3]),
      marginBottom: cs(theme, theme.spacing[1]),
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "lg"),
    },

    paragraph: {
      ...baseStyles.paragraph,
      ...debugSpacingBg(theme),
      marginBottom: cs(theme, theme.spacing[2]),
    },

    code_inline: {
      ...baseStyles.code_inline,
      fontSize: theme.fontSize.code,
    },

    code_block: {
      ...baseStyles.code_block,
      fontSize: theme.fontSize.code,
      padding: cs(theme, theme.spacing[2]),
    },

    fence: {
      ...baseStyles.fence,
      fontSize: theme.fontSize.code,
      padding: cs(theme, theme.spacing[2]),
    },
  };
}
