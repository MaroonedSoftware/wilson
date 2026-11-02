/**
 * `ask_user`'s schema, its limits and the pure functions over it — modelled on `chat.suggestions.ts`:
 * limits as named constants, pure functions, a prompt-instruction string, all unit-testable with no
 * database. `chat.tools.ts` hands `QUESTIONS_SCHEMA` to the tool; `chat.question.repository.ts` and
 * `ChatService` hold the row this produces.
 */

import { Duration } from 'luxon';
import { z } from 'zod';

/** The most questions one `ask_user` call may ask at once. */
export const MAX_QUESTIONS = 4;
/** The fewest suggested options a question may offer. */
export const MIN_OPTIONS = 2;
/** The most suggested options a question may offer. */
export const MAX_OPTIONS = 4;
/** The longest a question's header may be. */
export const MAX_HEADER_LENGTH = 60;
/** The longest a question's own text may be. */
export const MAX_TEXT_LENGTH = 200;
/** The longest one option's label may be. */
export const MAX_LABEL_LENGTH = 60;
/** The longest one option's description may be. */
export const MAX_DESCRIPTION_LENGTH = 120;
/** The longest the person's free-text "Other" answer may be. */
export const MAX_OTHER_LENGTH = 500;

/** How long the person has to answer a question before it lapses. Built the same way `PROPOSAL_TTL` is
 * (`chat.tools.ts`), and kept as its own constant rather than imported from there so the two can be
 * tuned apart — nothing says a question and a proposed change must lapse on the same clock. */
export const QUESTION_TTL = Duration.fromObject({ minutes: 10 });

export interface AskedOption {
    label: string;
    description: string;
}

export interface AskedQuestion {
    header: string;
    text: string;
    options: AskedOption[];
    multiSelect: boolean;
}

/** One question's answer: the options chosen, by index into its own `options`, and any "Other" text. */
export interface QuestionAnswer {
    chosen: number[];
    other?: string;
}

const OPTION_SCHEMA = z.object({
    label: z.string().max(MAX_LABEL_LENGTH).describe('The option as a short label, e.g. "Postgres".'),
    description: z.string().max(MAX_DESCRIPTION_LENGTH).describe('One short phrase saying what choosing this option means.'),
});

const QUESTION_SCHEMA = z.object({
    header: z.string().max(MAX_HEADER_LENGTH).describe('A short label for this question, e.g. "Database".'),
    text: z.string().max(MAX_TEXT_LENGTH).describe('The question itself, as you would ask it.'),
    options: z
        .array(OPTION_SCHEMA)
        .min(MIN_OPTIONS)
        .max(MAX_OPTIONS)
        .describe(`Between ${MIN_OPTIONS} and ${MAX_OPTIONS} suggested answers. An "Other" free-text box is always offered; never add one here.`),
    multiSelect: z.boolean().describe('true if the person may pick more than one option, false for exactly one.'),
});

/**
 * `ask_user`'s input: 1-4 related questions in one call. Stays a plain `z.ZodObject<z.ZodRawShape>`
 * whose `.shape` the Agent SDK can serve (`cli.chat.engine.ts` hands `input.shape` to `tool()`).
 */
export const QUESTIONS_SCHEMA = z.object({
    questions: z.array(QUESTION_SCHEMA).min(1).max(MAX_QUESTIONS).describe(`1 to ${MAX_QUESTIONS} related questions to ask together, in one prompt.`),
});

const other = (answer: QuestionAnswer): string => answer.other?.trim() ?? '';

/**
 * Why a submission cannot be accepted, in plain English, or undefined when it is fine. Validated
 * against the stored question itself, never a label string match: `chosen` is always an index.
 */
export const validateAnswers = (questions: AskedQuestion[], answers: QuestionAnswer[]): string | undefined => {
    if (answers.length !== questions.length) return `expected ${questions.length} answer(s), got ${answers.length}`;

    for (let i = 0; i < questions.length; i++) {
        const question = questions[i]!;
        const answer = answers[i]!;
        const seen = new Set<number>();
        for (const index of answer.chosen) {
            if (index < 0 || index >= question.options.length) return `question ${i + 1} ("${question.header}") chose an option that does not exist`;
            if (seen.has(index)) return `question ${i + 1} ("${question.header}") chose the same option twice`;
            seen.add(index);
        }
        if (!question.multiSelect && answer.chosen.length > 1) return `question ${i + 1} ("${question.header}") allows only one choice`;
        if (answer.chosen.length === 0 && other(answer) === '') return `question ${i + 1} ("${question.header}") was left unanswered`;
        if (other(answer).length > MAX_OTHER_LENGTH) return `question ${i + 1} ("${question.header}")'s "Other" text is too long`;
    }
    return undefined;
};

/** The answers as prose for the agent's note: each question's header, the labels chosen, and any "Other" text. */
export const describeAnswers = (questions: AskedQuestion[], answers: QuestionAnswer[]): string =>
    questions
        .map((question, i) => {
            const answer = answers[i]!;
            const labels = answer.chosen.map(index => question.options[index]!.label);
            const said = other(answer);
            const parts = [...labels, ...(said ? [`Other: ${said}`] : [])];
            return `${question.header}: ${parts.length > 0 ? parts.join(', ') : '(no answer)'}`;
        })
        .join('\n');

/** The prompt line asking the agent to use the structured question when it needs one, naming no tool. */
export const QUESTIONS_INSTRUCTION =
    'When you need the person to choose between options, or to give you something missing before you can carry on, ask a structured question ' +
    `rather than writing it in prose: up to ${MAX_QUESTIONS} short, related questions in one prompt, each with ${MIN_OPTIONS}-${MAX_OPTIONS} ` +
    'suggested options; an "Other" free-text box is always offered, so never add one yourself. It returns immediately and the person\'s answer ' +
    'arrives separately, so say what you asked and wait for it rather than guessing.';
