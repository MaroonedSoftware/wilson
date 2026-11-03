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
 * generated from [CodeEntry](../../../../apps/api/data/contracts/code.ck)
 */
export interface CodeEntry {
    name: string;
    path: string;
    type: 'file' | 'directory' | 'symlink' | 'submodule';
    /** A file's size in bytes. */
    size?: number;
    /** True for a name the deny list covers: shown, because the name is not the secret, but unreadable. */
    denied?: boolean;
}

/**
 * generated from [CodeFilePage](../../../../apps/api/data/contracts/code.ck)
 */
export interface CodeFilePage {
    commit: string;
    path: string;
    content: string;
    /** The 1-based line `content` starts on. */
    offset: number;
    totalLines: number;
    /** Where the next page starts; absent on the last one. */
    nextOffset?: number;
    /** True when one line alone was over the page budget, so this page holds only the start of it. */
    lineTruncated?: boolean;
}

/**
 * generated from [CodeMatch](../../../../apps/api/data/contracts/code.ck)
 */
export interface CodeMatch {
    path: string;
    line: number;
    excerpt: string;
}

/**
 * `ref` on all three: a plain branch or tag name, `HEAD` of the project's code root when left out.
 * Revision syntax and commit ids are refused.
 * generated from [CodeListQuery](../../../../apps/api/data/contracts/code.ck)
 */
export interface CodeListQuery {
    path?: string;
    ref?: string;
}

/**
 * generated from [CodeReadQuery](../../../../apps/api/data/contracts/code.ck)
 */
export interface CodeReadQuery {
    path: string;
    ref?: string;
    /** The 1-based line to start from. */
    offset?: number;
    /** How many lines, 400 when left out. A page also stops at its byte budget. */
    limit?: number;
}

/**
 * generated from [CodeSearchQuery](../../../../apps/api/data/contracts/code.ck)
 */
export interface CodeSearchQuery {
    /** An extended regular expression. */
    pattern: string;
    path?: string;
    ref?: string;
}

/**
 * generated from [CodeListing](../../../../apps/api/data/contracts/code.ck)
 */
export interface CodeListing {
    commit: string;
    path: string;
    entries: CodeEntry[];
}

/**
 * generated from [CodeSearchResult](../../../../apps/api/data/contracts/code.ck)
 */
export interface CodeSearchResult {
    commit: string;
    matches: CodeMatch[];
    /** True when there were more matches than this holds, or an excerpt was cut. */
    truncated: boolean;
}
