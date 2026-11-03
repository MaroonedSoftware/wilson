import { z } from 'zod';
import { explainError } from '#modules/chat/chat.catalog.js';
import type { ChatTool } from '#modules/chat/chat.tools.js';
import { isDeniedPath, type CodeReader } from '#modules/code/code.reader.js';
import type { CodeReadOperation } from '#modules/code/code.read.repository.js';
import type { DiffFileEntry } from '#modules/worktree/worktree.manager.js';
import { lineNumberOn, parseHunks, type DiffSide } from './diff.hunks.js';
import type { TourAnchor, TourStep } from './review.repository.js';

/** The most any one tool answer hands the agent, so one huge file can't fill its context. */
export const MAX_TOOL_RESULT = 64 * 1024;

const capped = (text: string): string =>
    text.length <= MAX_TOOL_RESULT ? text : `${text.slice(0, MAX_TOOL_RESULT)}\n\n(cut at ${MAX_TOOL_RESULT} characters; read a narrower range)`;

/** Run one read through the caller's audit, so an agent's reads are on record as a person's are. */
export type AuditedRead = <T extends { commit: string }>(
    operation: CodeReadOperation,
    query: { path?: string; pattern?: string },
    run: () => Promise<T>,
) => Promise<T>;

/** What a review turn's tools read. Everything here is bound to one commit before the agent sees it. */
export interface ReviewToolContext {
    files: DiffFileEntry[];
    reader: CodeReader;
    audited: AuditedRead;
    /** Store a checked tour and show it to whoever is watching. */
    setTour: (tour: TourStep[]) => Promise<void>;
}

/** A refused or failed read is the agent's to reason about, so it comes back as text rather than ending the turn. */
const answering =
    <I>(run: (input: I) => Promise<unknown>) =>
    async (input: Record<string, unknown>): Promise<string> => {
        try {
            const result = await run(input as I);
            return capped(typeof result === 'string' ? result : JSON.stringify(result));
        } catch (err) {
            return `Refused: ${explainError(err)}`;
        }
    };

const MAX_TOUR_STEPS = 30;
const MAX_STEP_ANCHORS = 8;

const TOUR_INPUT = z.object({
    steps: z
        .array(
            z.object({
                title: z.string().min(1).describe('A few words naming this step.'),
                explanation: z.string().min(1).describe('What this part of the change does and why, in Markdown. Say what the person should check.'),
                anchors: z
                    .array(
                        z.object({
                            file: z.string(),
                            side: z
                                .enum(['old', 'new'])
                                .describe('`new` for the file at the commit under review, `old` only for lines the change removed.'),
                            startLine: z.number().int().positive(),
                            endLine: z.number().int().positive(),
                        }),
                    )
                    .max(MAX_STEP_ANCHORS)
                    .describe('The code this step is about. Prefer lines the change touched.'),
            }),
        )
        .min(1)
        .max(MAX_TOUR_STEPS),
});
type TourInput = z.infer<typeof TOUR_INPUT>;
type AnchorInput = TourInput['steps'][number]['anchors'][number];

/** Whether any line the diff shows on `side` of `file` falls in the range. */
const inHunks = (file: DiffFileEntry, side: DiffSide, startLine: number, endLine: number): boolean =>
    parseHunks(file.patch).some(hunk =>
        hunk.lines.some(line => {
            const number = lineNumberOn(line, side);
            return number !== undefined && number >= startLine && number <= endLine;
        }),
    );

/**
 * Where one anchor lands, or a sentence saying why it can't stand, for the agent to put right. Code the
 * change didn't touch is fine, since explaining a change often means pointing at what it calls, but an
 * anchor must name a real place. The old side can only be checked against the diff, because the reader
 * is bound to the new commit.
 */
const statusOf = async (
    { file: path, side, startLine, endLine }: AnchorInput,
    { files, reader, audited }: ReviewToolContext,
): Promise<TourAnchor['status'] | string> => {
    if (startLine > endLine) return `${path}: startLine ${startLine} is after endLine ${endLine}.`;
    if (isDeniedPath(path)) return `${path} is on the deny list, because files like it hold secrets.`;

    const file = files.find(candidate => candidate.path === path);
    if (file?.truncated) return 'truncated';
    if (file && inHunks(file, side, startLine, endLine)) return 'in-diff';
    if (side === 'old') return `${path}:${startLine} is not a removed line this change shows. Use the new side for code that is still there.`;

    const page = await audited('read', { path }, () => reader.read({ path, offset: startLine, limit: 1 }));
    return endLine <= page.totalLines ? 'outside-diff' : `${path} has ${page.totalLines} lines, so it has no line ${endLine}.`;
};

/** Check every anchor before storing anything, so a tour is replaced whole or not at all. */
const checkedTour = async ({ steps }: TourInput, context: ReviewToolContext): Promise<TourStep[] | string[]> => {
    const problems: string[] = [];
    const checked: TourStep[] = [];
    for (const step of steps) {
        const anchors: TourAnchor[] = [];
        for (const anchor of step.anchors) {
            const status = await statusOf(anchor, context).catch(err => `${anchor.file}: ${explainError(err)}`);
            if (status === 'in-diff' || status === 'outside-diff' || status === 'truncated') anchors.push({ ...anchor, status });
            else problems.push(status);
        }
        checked.push({ title: step.title, explanation: step.explanation, anchors });
    }
    return problems.length > 0 ? problems : checked;
};

const isProblems = (result: TourStep[] | string[]): result is string[] => typeof result[0] === 'string';

/**
 * The review agent's whole surface: read the change, read the code, and write the tour. Nothing here
 * touches the project, and no tool gives a verdict. The engine is given no built-in tools beside them (`ChatTurnInput.onlyOwnTools`).
 *
 * `patchSinceFork` does not apply the code reader's deny list, because a person reading their own diff
 * already has the repository. An agent's reads go to a model provider, so a denied file's patch stops
 * here as the reader itself would stop it.
 */
export const reviewTools = (context: ReviewToolContext): ChatTool[] => {
    const { files, reader, audited } = context;
    return [
        {
            name: 'list_changed_files',
            description: 'List every file the change touches, with its status. Start here.',
            input: z.object({}),
            execute: answering(async () =>
                files.map(file => ({
                    path: file.path,
                    status: file.status,
                    ...(file.truncated && { truncated: true }),
                    ...(isDeniedPath(file.path) && { denied: true }),
                })),
            ),
        },
        {
            name: 'read_change',
            description: "Read one changed file's unified diff, with line numbers in its hunk headers.",
            input: z.object({ path: z.string().describe('The path as the list of changed files gives it.') }),
            execute: answering(async ({ path }: { path: string }) => {
                if (isDeniedPath(path)) return `"${path}" is on the deny list, because files like it hold secrets.`;
                const file = files.find(candidate => candidate.path === path);
                if (!file) return `"${path}" is not part of this change.`;
                return file.truncated ? `The diff of "${path}" is too large to show. Read the file itself instead.` : file.patch;
            }),
        },
        {
            name: 'list_directory',
            description: 'List a directory of the project at the commit under review, the root when path is left out.',
            input: z.object({ path: z.string().optional() }),
            execute: answering(({ path }: { path?: string }) => audited('list', { path }, () => reader.list({ path }))),
        },
        {
            name: 'read_file',
            description: 'Read one page of a text file at the commit under review, by line. A long file answers with where the next page starts.',
            input: z.object({
                path: z.string(),
                offset: z.number().int().positive().optional().describe('The 1-based line to start from.'),
                limit: z.number().int().positive().optional().describe('How many lines to read.'),
            }),
            execute: answering(({ path, offset, limit }: { path: string; offset?: number; limit?: number }) =>
                audited('read', { path }, () => reader.read({ path, offset, limit })),
            ),
        },
        {
            name: 'search_code',
            description: 'Search the contents of the project at the commit under review, optionally under one path.',
            input: z.object({ pattern: z.string(), path: z.string().optional() }),
            execute: answering(({ pattern, path }: { pattern: string; path?: string }) =>
                audited('search', { pattern, path }, () => reader.search({ pattern, path })),
            ),
        },
        {
            name: 'set_tour',
            description:
                "Publish the ordered walk through this change, replacing any earlier one. It appears beside the diff as you call it. If an anchor can't stand, nothing is published and the answer says what to fix.",
            input: TOUR_INPUT,
            execute: answering(async (input: TourInput) => {
                const checked = await checkedTour(input, context);
                if (isProblems(checked)) return `Not published. Fix these and call again:\n${checked.join('\n')}`;
                await context.setTour(checked);
                return `Published ${checked.length} step(s).`;
            }),
        },
    ];
};
