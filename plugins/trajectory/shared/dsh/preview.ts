/**
 * Bounded Markdown-to-text projection shared by trajectory consumers.
 *
 * Ported from DeepSeek deepseek-harness `packages/client/ui-trajectory/src/client/trajectory-preview.ts`
 * (llm-server-monitoring repo, commit afd92680f2, MIT License — Copyright (c) 2026 DeepSeek).
 * Change from upstream: `extractMarkdownPlainText` (dsh ui-primitives) is replaced
 * by a local structural strip; the bounded-window contract is unchanged.
 */

const PREVIEW_SOURCE_CHARACTERS = 2_048;
const PREVIEW_OUTPUT_CHARACTERS = 512;

/**
 * Structural Markdown-to-text strip. Deliberately shallow: the preview is a
 * one-line summary, not a renderer. Fences, inline code markers, emphasis
 * markers, links (label kept), and headings are dropped.
 * @param text - Markdown source text.
 * @returns Text with Markdown markers removed.
 */
function extractMarkdownPlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (fence) => fence.replace(/```[a-z]*\n?/g, ""))
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*_~]/g, "");
}

/**
 * Build a bounded one-line preview without parsing the complete Markdown document.
 * @param text - Untrusted message, reasoning, payload, or result text.
 * @returns A compact preview capped independently from the retained source.
 */
export function trajectoryPreviewText(text: string): string {
  const source = text.slice(0, PREVIEW_SOURCE_CHARACTERS);
  const compact = extractMarkdownPlainText(source).replace(/\s+/g, " ").trim();
  const preview = compact.slice(0, PREVIEW_OUTPUT_CHARACTERS).trimEnd();
  return source.length < text.length || preview.length < compact.length ? `${preview}…` : preview;
}
