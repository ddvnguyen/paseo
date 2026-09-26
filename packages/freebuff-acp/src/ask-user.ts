import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import type { CodebuffClient } from "@codebuff/sdk";

/**
 * Bridge for the SDK's `ask_user` tool. The SDK has no UI of its own, so the
 * questions are put to the host as an ACP permission request.
 *
 * Two layers, so every host gets something usable:
 *
 * 1. Rich form (Paseo): all questions ride in `_meta["paseo/questions"]`
 *    (multi-select, free-text "other"). The host answers in the response's
 *    `_meta["paseo/answers"]` as `header -> answer string`, multi-select
 *    labels joined with ", ".
 * 2. Chooser fallback (any ACP host): the first question's options are also
 *    sent as plain permission options. A host that ignores the extension
 *    returns just a selected option; remaining questions are then asked one
 *    at a time, single-choice.
 */

type OverrideTools = NonNullable<ConstructorParameters<typeof CodebuffClient>[0]["overrideTools"]>;
type AskUserTool = NonNullable<OverrideTools["ask_user"]>;

export const QUESTIONS_META_KEY = "paseo/questions";
export const ANSWERS_META_KEY = "paseo/answers";

interface AskUserQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

type HeadedQuestion = AskUserQuestion & { header: string };

export interface AskUserHost {
  sessionId: string;
  requestPermission(
    params: RequestPermissionRequest,
  ): Promise<{ outcome: { outcome: string; optionId?: string }; _meta?: unknown }>;
}

interface AnswerOutput {
  questionIndex: number;
  selectedOption?: string;
  selectedOptions?: string[];
  otherText?: string;
}

const SUBMIT_OPTION_ID = "ask-user-submit";
const SKIP_OPTION_ID = "ask-user-skip";
const SKIPPED = [{ type: "json" as const, value: { skipped: true } }];

/** Answers are keyed by header, so headers must be unique and non-empty. */
function withUniqueHeaders(questions: AskUserQuestion[]): HeadedQuestion[] {
  const used = new Set<string>();
  return questions.map((question, index) => {
    let header = question.header?.trim() || `Question ${index + 1}`;
    while (used.has(header)) header = `${header} (${index + 1})`;
    used.add(header);
    return { ...question, header };
  });
}

function toFormQuestion(question: HeadedQuestion) {
  return {
    question: question.question,
    header: question.header,
    options: question.options.map((option) => ({
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
    multiSelect: question.multiSelect === true,
    // The user can always answer in their own words.
    allowOther: true,
  };
}

/** Permission options for one question's choices (plus a Skip). */
function chooserOptions(
  question: AskUserQuestion,
  questionIndex: number,
): { options: RequestPermissionRequest["options"]; labels: Map<string, string> } {
  const labels = new Map<string, string>();
  const options: RequestPermissionRequest["options"] = question.options.map((option, index) => {
    const optionId = `ask-user-${questionIndex}-${index}`;
    labels.set(optionId, option.label);
    return {
      optionId,
      name: option.description ? `${option.label} — ${option.description}` : option.label,
      kind: "allow_once",
    };
  });
  return { options, labels };
}

/**
 * Turn a host answer string into the SDK's answer shape. Multi-select answers
 * are option labels joined with ", " (labels may themselves contain commas, so
 * match known labels rather than splitting blindly); anything left over is the
 * user's free text.
 */
export function answerToOutput(
  question: AskUserQuestion,
  questionIndex: number,
  answer: string,
): AnswerOutput | null {
  const text = answer.trim();
  if (text === "") return null;
  const labels = question.options.map((option) => option.label);

  if (question.multiSelect !== true) {
    return labels.includes(text)
      ? { questionIndex, selectedOption: text }
      : { questionIndex, otherText: text };
  }

  const selected: string[] = [];
  let remaining = text;
  const byLength = [...labels].sort((a, b) => b.length - a.length);
  while (remaining.length > 0) {
    const label = byLength.find(
      (candidate) =>
        remaining.startsWith(candidate) &&
        (remaining.length === candidate.length || remaining.startsWith(", ", candidate.length)),
    );
    if (!label) break;
    selected.push(label);
    remaining = remaining.slice(label.length).replace(/^, /, "");
  }
  const otherText = remaining.trim();
  return {
    questionIndex,
    ...(selected.length > 0 ? { selectedOptions: selected } : {}),
    ...(otherText ? { otherText } : {}),
  };
}

function readAnswers(meta: unknown): Record<string, string> | null {
  if (typeof meta !== "object" || meta === null) return null;
  const answers = (meta as Record<string, unknown>)[ANSWERS_META_KEY];
  if (typeof answers !== "object" || answers === null) return null;
  const record: Record<string, string> = {};
  for (const [header, value] of Object.entries(answers)) {
    if (typeof value === "string") record[header] = value;
  }
  return record;
}

/** Single-choice question for hosts without the rich-form extension. */
async function askChoice(
  host: AskUserHost,
  question: AskUserQuestion,
  questionIndex: number,
): Promise<string | null> {
  const { options, labels } = chooserOptions(question, questionIndex);
  options.push({ optionId: SKIP_OPTION_ID, name: "Skip", kind: "reject_once" });
  try {
    const response = await host.requestPermission({
      sessionId: host.sessionId,
      toolCall: {
        toolCallId: `freebuff-ask-${crypto.randomUUID()}`,
        title: question.question,
        status: "pending",
      },
      options,
    });
    return response.outcome.outcome === "selected" && response.outcome.optionId
      ? (labels.get(response.outcome.optionId) ?? null)
      : null;
  } catch {
    return null;
  }
}

export function createAskUserTool(getHost: () => AskUserHost | null): AskUserTool {
  return async (rawInput) => {
    const input = rawInput as unknown as { questions: AskUserQuestion[] };
    const host = getHost();
    if (!host || input.questions.length === 0) return SKIPPED;

    const questions = withUniqueHeaders(input.questions);
    const first = questions[0]!;

    // Fallback options: the first question's choices. A question with no
    // choices (pure free text) needs an explicit allow option to submit with.
    const { options, labels } = chooserOptions(first, 0);
    if (options.length === 0) {
      options.push({ optionId: SUBMIT_OPTION_ID, name: "Submit answers", kind: "allow_once" });
    }
    options.push({ optionId: SKIP_OPTION_ID, name: "Skip", kind: "reject_once" });

    let response: Awaited<ReturnType<AskUserHost["requestPermission"]>>;
    try {
      response = await host.requestPermission({
        sessionId: host.sessionId,
        toolCall: {
          toolCallId: `freebuff-ask-${crypto.randomUUID()}`,
          title: first.question,
          status: "pending",
        },
        options,
        _meta: { [QUESTIONS_META_KEY]: questions.map(toFormQuestion) },
      });
    } catch {
      return SKIPPED;
    }
    if (response.outcome.outcome !== "selected") return SKIPPED;

    // Rich form answered.
    const formAnswers = readAnswers(response._meta);
    if (formAnswers) {
      const answers = questions.flatMap((question, index) => {
        const output = answerToOutput(question, index, formAnswers[question.header] ?? "");
        return output ? [output] : [];
      });
      return [{ type: "json", value: answers.length > 0 ? { answers } : { skipped: true } }];
    }

    // Chooser fallback: the host only reported which option was picked.
    const optionId = response.outcome.optionId;
    const firstChoice = optionId ? labels.get(optionId) : undefined;
    if (firstChoice === undefined && optionId !== SUBMIT_OPTION_ID) return SKIPPED;
    const answers: AnswerOutput[] = [];
    if (firstChoice !== undefined) answers.push({ questionIndex: 0, selectedOption: firstChoice });
    for (let index = 1; index < questions.length; index++) {
      const choice = await askChoice(host, questions[index]!, index);
      if (choice === null) break;
      answers.push({ questionIndex: index, selectedOption: choice });
    }
    return [{ type: "json", value: answers.length > 0 ? { answers } : { skipped: true } }];
  };
}
