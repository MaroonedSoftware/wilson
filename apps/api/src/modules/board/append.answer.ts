const HEADING = '## Operator answer';

/** One question a stage stopped to ask, and what a person said. */
export interface OperatorAnswer {
    /** The stage that asked. */
    stage: string;
    question: string;
    /** When the stage asked, as an ISO timestamp. */
    askedAt: string;
    answer: string;
    /** When the person answered, as an ISO timestamp. */
    answeredAt: string;
    /** Where the stopped run's uncommitted work is preserved, when it left any. */
    patchPath?: string;
}

/**
 * Text set off as a quotation, line by line. The prefix is also what keeps it from being read as
 * structure: a `## Goal` in an answer must not start a section in the plan.
 */
const quoted = (text: string): string[] =>
    text
        .trim()
        .split('\n')
        .map(line => (line.trim().length > 0 ? `> ${line}` : '>'));

const entry = ({ stage, question, askedAt, answer, answeredAt, patchPath }: OperatorAnswer): string[] => [
    `**${stage}** asked (${askedAt}):`,
    '',
    ...quoted(question),
    '',
    `The answer (${answeredAt}):`,
    '',
    ...quoted(answer),
    ...(patchPath ? ['', `Uncommitted work from the run that asked is preserved at \`${patchPath}\`. Read it and reuse what still applies.`] : []),
];

/** Where the section is in `lines`: its heading, and the next heading after it, or the end. */
const sectionBounds = (lines: string[]): { start: number; end: number } | undefined => {
    const start = lines.findIndex(line => line.trim() === HEADING);
    if (start === -1) return undefined;
    const next = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
    return { start, end: next === -1 ? lines.length : next };
};

/**
 * Add a person's answer to a card body, under a `## Operator answer` section.
 *
 * Runner-appended like `## Previous attempts` (`append.attempts.ts`) and accumulating the same way:
 * a stage that asks again still needs what it was told the first time, and the dispatcher's cap on
 * questions keeps the section short. `withoutAnswers` is the "shed on pass" half.
 */
export const withAnswer = (body: string, answer: OperatorAnswer): string => {
    const lines = body.split('\n');
    const bounds = sectionBounds(lines);
    const existing = bounds ? lines.slice(bounds.start + 1, bounds.end) : [];
    const earlier = existing.join('\n').trim();
    const before = bounds ? lines.slice(0, bounds.start) : lines;
    const after = bounds ? lines.slice(bounds.end) : [];

    const section = [
        HEADING,
        '',
        ...(earlier
            ? [earlier]
            : ['This stage stopped to ask a person a question. The answer is part of the plan: follow it, and do not ask the same thing again.']),
        '',
        ...entry(answer),
    ];
    const needsLeadingBlank = before.length > 0 && before[before.length - 1]?.trim() !== '';

    return [...before, ...(needsLeadingBlank ? [''] : []), ...section, ...(after.length > 0 ? ['', ...after] : [''])].join('\n');
};

/** Remove the section: the stage that needed the answer has passed. No section round-trips unchanged. */
export const withoutAnswers = (body: string): string => {
    const lines = body.split('\n');
    const bounds = sectionBounds(lines);
    return bounds ? [...lines.slice(0, bounds.start), ...lines.slice(bounds.end)].join('\n') : body;
};
