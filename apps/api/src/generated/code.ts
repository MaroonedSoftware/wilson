import { z } from 'zod';

/**
 * Card 0005. Read a registered project's committed code: list a directory, read a file, search
 * contents. Which project comes from the request's own project context (`ProjectContextRouter`,
 * `ChatCatalog.run`), never from a path a caller supplies, so an unregistered one is already refused.
 *
 * Gated with `wilson.view`, which any session or key satisfies: Wilson has one account, so there is
 * no per-project visibility to check (`access.policies.ts`). That means a `view` API key can read the
 * source of every registered project, and that these reach MCP clients as well as the chat.
 *
 * Every read goes through git against one resolved commit, and every response names that commit,
 * because nothing here fetches and a clone can lag its remote. See `code.reader.ts` for the limits,
 * and `wilson.code_reads` for the record every read and refusal leaves.
 * generated from [CodeEntry](../../data/contracts/code.ck)
 */
export const CodeEntry = z.strictObject({
    name: z.string(),
    path: z.string(),
    type: z.enum(['file', 'directory', 'symlink', 'submodule']),
    size: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .optional()
        .describe("A file's size in bytes."),
    denied: z
        .preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        .optional()
        .describe('True for a name the deny list covers: shown, because the name is not the secret, but unreadable.'),
});
export type CodeEntry = z.infer<typeof CodeEntry>;

/**
 * generated from [CodeFilePage](../../data/contracts/code.ck)
 */
export const CodeFilePage = z.strictObject({
    commit: z.string(),
    path: z.string(),
    content: z.string(),
    offset: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .describe('The 1-based line `content` starts on.'),
    totalLines: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    nextOffset: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .optional()
        .describe('Where the next page starts; absent on the last one.'),
    lineTruncated: z
        .preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        .optional()
        .describe('True when one line alone was over the page budget, so this page holds only the start of it.'),
});
export type CodeFilePage = z.infer<typeof CodeFilePage>;

/**
 * generated from [CodeMatch](../../data/contracts/code.ck)
 */
export const CodeMatch = z.strictObject({
    path: z.string(),
    line: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()),
    excerpt: z.string(),
});
export type CodeMatch = z.infer<typeof CodeMatch>;

/**
 * `ref` on all three: a plain branch or tag name, `HEAD` of the project's code root when left out.
 * Revision syntax and commit ids are refused.
 * generated from [CodeListQuery](../../data/contracts/code.ck)
 */
export const CodeListQuery = z.strictObject({
    path: z.string().optional(),
    ref: z.string().optional(),
});
export type CodeListQuery = z.infer<typeof CodeListQuery>;

/**
 * generated from [CodeReadQuery](../../data/contracts/code.ck)
 */
export const CodeReadQuery = z.strictObject({
    path: z.string(),
    ref: z.string().optional(),
    offset: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .optional()
        .describe('The 1-based line to start from.'),
    limit: z
        .preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int())
        .optional()
        .describe('How many lines, 400 when left out. A page also stops at its byte budget.'),
});
export type CodeReadQuery = z.infer<typeof CodeReadQuery>;

/**
 * generated from [CodeSearchQuery](../../data/contracts/code.ck)
 */
export const CodeSearchQuery = z.strictObject({
    pattern: z.string().describe('An extended regular expression.'),
    path: z.string().optional(),
    ref: z.string().optional(),
});
export type CodeSearchQuery = z.infer<typeof CodeSearchQuery>;

/**
 * generated from [CodeListing](../../data/contracts/code.ck)
 */
export const CodeListing = z.strictObject({
    commit: z.string(),
    path: z.string(),
    entries: z.array(CodeEntry),
});
export type CodeListing = z.infer<typeof CodeListing>;

/**
 * generated from [CodeSearchResult](../../data/contracts/code.ck)
 */
export const CodeSearchResult = z.strictObject({
    commit: z.string(),
    matches: z.array(CodeMatch),
    truncated: z
        .preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
        .describe('True when there were more matches than this holds, or an excerpt was cut.'),
});
export type CodeSearchResult = z.infer<typeof CodeSearchResult>;
