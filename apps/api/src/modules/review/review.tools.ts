import { z } from 'zod';
import { explainError } from '#modules/chat/chat.catalog.js';
import type { ChatTool } from '#modules/chat/chat.tools.js';
import { isDeniedPath, type CodeReader } from '#modules/code/code.reader.js';
import type { CodeReadOperation } from '#modules/code/code.read.repository.js';
import type { DiffFileEntry } from '#modules/worktree/worktree.manager.js';

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

/**
 * The review agent's whole surface: read the change and read the code. Nothing here writes, and the
 * engine is given no built-in tools beside them (`ChatTurnInput.onlyOwnTools`).
 *
 * `patchSinceFork` does not apply the code reader's deny list, because a person reading their own diff
 * already has the repository. An agent's reads go to a model provider, so a denied file's patch stops
 * here as the reader itself would stop it.
 */
export const reviewTools = ({ files, reader, audited }: ReviewToolContext): ChatTool[] => [
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
];
