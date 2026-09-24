/**
 * Opt-in ACP extension (over `_meta`) for rich questions.
 *
 * An agent attaches `_meta["paseo/questions"]` to `session/request_permission`
 * to ask for multi-select or free-text answers. The host answers in the
 * response's `_meta["paseo/answers"]`: `header -> answer string`, with
 * multi-select labels joined by ", " (the same encoding the question form
 * uses for every provider). Agents keep sending ordinary chooser options as
 * well, so hosts without this extension still show a working single-choice
 * prompt.
 */
export const ACP_QUESTIONS_META_KEY = "paseo/questions";
export const ACP_ANSWERS_META_KEY = "paseo/answers";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Questions from a permission request's `_meta`, or null when absent/malformed. */
export function readAcpQuestions(meta: unknown): Record<string, unknown>[] | null {
  const raw = isRecord(meta) ? meta[ACP_QUESTIONS_META_KEY] : undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    return null;
  }
  const questions: Record<string, unknown>[] = [];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      typeof entry.question !== "string" ||
      typeof entry.header !== "string" ||
      !Array.isArray(entry.options)
    ) {
      return null;
    }
    questions.push(entry);
  }
  return questions;
}

/** `_meta` for the permission response carrying the user's answers, if any. */
export function acpAnswersResponseMeta(
  updatedInput: unknown,
): { _meta: Record<string, unknown> } | Record<string, never> {
  const answers = isRecord(updatedInput) ? updatedInput.answers : undefined;
  return isRecord(answers) ? { _meta: { [ACP_ANSWERS_META_KEY]: answers } } : {};
}
