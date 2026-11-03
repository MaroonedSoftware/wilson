import type { ExecFailure, ExecutionHost } from '#modules/host/execution.host.js';
import { localHost } from '#modules/host/local.execution.host.js';

/** Lines one read returns unless it asks for fewer or more. */
export const READ_DEFAULT_LIMIT = 400;
/**
 * The most one response carries of a file or of search matches, counted after JSON escaping. The chat
 * cuts a result at `RESULT_CAP` (20,000), and a cut would land inside a page and break `nextOffset`.
 */
export const RESPONSE_BUDGET = 12_000;
/** A blob larger than this is refused from its recorded size, before it is read. */
export const BLOB_MAX_BYTES = 5 * 1024 * 1024;
/** How far into a blob a NUL byte makes it binary, the same distance git itself looks. */
export const BINARY_SNIFF_LENGTH = 8_000;
export const SEARCH_MAX_MATCHES = 100;
export const SEARCH_EXCERPT_LENGTH = 200;
export const GIT_TIMEOUT_MS = 10_000;

/** Enough for a blob at {@link BLOB_MAX_BYTES} and any listing a real tree has. */
const GIT_BUFFER = 8 * 1024 * 1024;
/** A search keeps only the first matches, so anything beyond this only reports that it was cut. */
const SEARCH_BUFFER = 4 * 1024 * 1024;

const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const TREE_ENTRY = /^(\d{6}) (\w+) ([0-9a-f]+) +(\S+)\t([\s\S]*)$/;
/** One `git grep -n -z` match: name, NUL, line number, NUL, text. The name carries `<sha>:` first. */
const GREP_MATCH = /([^\0]*)\0(\d+)\0([^\n]*)\n/g;

/** Matched against each segment of a path, lower-cased. The name is not the secret; the content is. */
const DENIED_SEGMENTS: RegExp[] = [
    /^\.git$/,
    /^\.env$/,
    /^\.env\./,
    /\.pem$/,
    /\.key$/,
    /\.p12$/,
    /\.pfx$/,
    /^id_rsa/,
    /^id_ed25519/,
    /^\.npmrc$/,
    /^\.netrc$/,
];

export type CodeEntryType = 'file' | 'directory' | 'symlink' | 'submodule';

export interface CodeEntry {
    name: string;
    path: string;
    type: CodeEntryType;
    /** A file's size in bytes. */
    size?: number;
    /** True for a name the deny list covers: shown, but its content cannot be read. */
    denied?: boolean;
}

export interface CodeListing {
    commit: string;
    path: string;
    entries: CodeEntry[];
}

export interface CodeFilePage {
    commit: string;
    path: string;
    content: string;
    /** The 1-based line `content` starts on. */
    offset: number;
    totalLines: number;
    /** Where the next page starts; absent on the last one. */
    nextOffset?: number;
    /** True when one line alone was over the budget, so this page holds only the start of it. */
    lineTruncated?: boolean;
}

export interface CodeMatch {
    path: string;
    line: number;
    excerpt: string;
}

export interface CodeSearchResult {
    commit: string;
    matches: CodeMatch[];
    /** True when there were more matches than this holds, or an excerpt was cut. */
    truncated: boolean;
}

/** A read this module declined, with the sentence why. `commit` is set once the ref had resolved. */
export class CodeRefusal extends Error {
    constructor(
        readonly reason: string,
        readonly commit?: string,
    ) {
        super(reason);
    }
}

export const isDeniedPath = (path: string): boolean =>
    path
        .toLowerCase()
        .split('/')
        .some(segment => DENIED_SEGMENTS.some(pattern => pattern.test(segment)));

/** `path` with no trailing slash, `''` for the root; refuses anything that is not repo-relative and literal. */
const checkedPath = (path: string | undefined): string => {
    const trimmed = (path ?? '').replace(/\/+$/, '');
    if (path?.startsWith('/')) throw new CodeRefusal(`path "${path}" is absolute; give it relative to the repository root`);
    if (trimmed === '' || trimmed === '.') return '';
    if (trimmed.includes('\0')) throw new CodeRefusal('a path cannot contain a NUL byte');
    if (trimmed.includes('\\')) throw new CodeRefusal(`path "${trimmed}" contains a backslash; separate segments with "/"`);
    const segments = trimmed.split('/');
    if (segments.includes('..')) throw new CodeRefusal(`path "${trimmed}" contains a ".." segment`);
    if (segments.includes('')) throw new CodeRefusal(`path "${trimmed}" contains an empty segment`);
    if (isDeniedPath(trimmed)) throw new CodeRefusal(`path "${trimmed}" is on the deny list, because files like it hold secrets`);
    return trimmed;
};

const checkedRef = (ref: string): string => {
    if (!REF_NAME.test(ref) || ref.includes('..')) {
        throw new CodeRefusal(`ref "${ref}" is not a plain branch or tag name; revision syntax and commit ids are not accepted`);
    }
    return ref;
};

/** What a string costs in a response: its bytes, or its JSON-escaped length if that is more. */
const costOf = (text: string): number => Math.max(Buffer.byteLength(text), JSON.stringify(text).length - 2);

/** The start of `line` that fits in `budget`, cut on a character boundary. */
const fitted = (line: string, budget: number): string => {
    let used = 0;
    let end = 0;
    for (const char of line) {
        used += costOf(char);
        if (used > budget) break;
        end += char.length;
    }
    return line.slice(0, end);
};

/**
 * Read one project's committed code through git, and nothing else.
 *
 * Every operation resolves its ref to one commit and then only ever hands git that SHA, so no value a
 * caller chose reaches git in a position where it could be read as an option: `git grep -O` runs a
 * command, and a ref starting with a dash would otherwise be one. Paths go after `--` under
 * `--literal-pathspecs`, patterns go through `-e`. Nothing here writes, checks out, fetches or cuts a
 * worktree, and the working tree is never read, so there is nothing for a symlink to escape from: one
 * is a tree entry whose content is refused, not a thing to follow.
 *
 * Runs git through the host directly rather than `git()` (`board/git.ts`), which takes no timeout and
 * wraps away the `killed` and `code` a refusal here depends on.
 *
 * `pinned` binds every read to one commit the server chose, for a reader handed to an agent reviewing
 * that commit. It is a constructor argument because a caller's `ref` still never names a commit: with
 * a pin, a `ref` at all is refused.
 */
export class CodeReader {
    constructor(
        private readonly codeRoot: string,
        private readonly host: ExecutionHost = localHost,
        private readonly pinned?: string,
    ) {}

    /** List a directory, the repository's root when `path` is left out. */
    async list({ path, ref }: { path?: string; ref?: string }): Promise<CodeListing> {
        const target = checkedPath(path);
        const commit = await this.resolve(ref);
        if (target !== '') {
            const entry = await this.entryAt(commit, target);
            if (entry.type !== 'directory') throw new CodeRefusal(`"${target}" is a ${entry.type}, not a directory`, commit);
        }
        const args = ['ls-tree', '-z', '-l', commit];
        const stdout = await this.run(target === '' ? args : [...args, '--', `${target}/`], commit);
        const entries = parseEntries(stdout).map(({ oid: _oid, ...entry }) => ({ ...entry, ...(isDeniedPath(entry.name) && { denied: true }) }));
        return { commit, path: target, entries };
    }

    /** One page of a text file, by line. */
    async read({
        path,
        ref,
        offset = 1,
        limit = READ_DEFAULT_LIMIT,
    }: {
        path: string;
        ref?: string;
        offset?: number;
        limit?: number;
    }): Promise<CodeFilePage> {
        const target = checkedPath(path);
        if (target === '') throw new CodeRefusal('reading needs the path of a file');
        if (!Number.isInteger(offset) || offset < 1) throw new CodeRefusal(`offset ${offset} is not a line number; the first line is 1`);
        if (!Number.isInteger(limit) || limit < 1) throw new CodeRefusal(`limit ${limit} is not a positive number of lines`);

        const commit = await this.resolve(ref);
        const entry = await this.entryAt(commit, target);
        if (entry.type === 'symlink') throw new CodeRefusal(`"${target}" is a symlink, which is not followed`, commit);
        if (entry.type !== 'file') throw new CodeRefusal(`"${target}" is a ${entry.type}, not a file`, commit);
        if ((entry.size ?? 0) > BLOB_MAX_BYTES) {
            throw new CodeRefusal(`"${target}" is ${entry.size} bytes, over the ${BLOB_MAX_BYTES} byte limit`, commit);
        }

        const text = await this.run(['cat-file', 'blob', entry.oid], commit);
        if (text.slice(0, BINARY_SNIFF_LENGTH).includes('\0')) throw new CodeRefusal(`"${target}" is a binary file`, commit);

        const lines = text.split('\n');
        if (lines.at(-1) === '') lines.pop();
        if (offset > Math.max(lines.length, 1)) throw new CodeRefusal(`"${target}" has ${lines.length} lines, so there is no line ${offset}`, commit);

        const end = Math.min(offset - 1 + limit, lines.length);
        const page: string[] = [];
        let used = 0;
        let next = offset - 1;
        let lineTruncated = false;
        while (next < end) {
            const line = lines[next]!;
            const cost = costOf(line) + 1;
            if (used + cost > RESPONSE_BUDGET) {
                if (page.length > 0) break;
                page.push(fitted(line, RESPONSE_BUDGET));
                lineTruncated = true;
                next += 1;
                break;
            }
            page.push(line);
            used += cost;
            next += 1;
        }

        return {
            commit,
            path: target,
            content: page.join('\n'),
            offset,
            totalLines: lines.length,
            ...(next < lines.length && { nextOffset: next + 1 }),
            ...(lineTruncated && { lineTruncated }),
        };
    }

    /** Search file contents with an extended regular expression, under `path` when given. */
    async search({ pattern, path, ref }: { pattern: string; path?: string; ref?: string }): Promise<CodeSearchResult> {
        if (pattern === '') throw new CodeRefusal('a search needs a pattern');
        if (pattern.includes('\0')) throw new CodeRefusal('a search pattern cannot contain a NUL byte');
        const target = checkedPath(path);
        const commit = await this.resolve(ref);
        if (target !== '') await this.entryAt(commit, target);

        // `--no-column` because a repository's own `grep.column` would change the output parsed below.
        const args = ['grep', '-n', '-z', '-I', '-E', '--no-color', '--no-column', '-e', pattern, commit];
        const { stdout, cut } = await this.grep(target === '' ? args : [...args, '--', target], commit);

        const prefix = `${commit}:`;
        const matches: CodeMatch[] = [];
        let used = 0;
        let truncated = cut;
        for (const [, name, line, text] of stdout.matchAll(GREP_MATCH)) {
            const path = name!.startsWith(prefix) ? name!.slice(prefix.length) : name!;
            if (isDeniedPath(path)) continue;
            const excerpt = text!.slice(0, SEARCH_EXCERPT_LENGTH);
            const cost = costOf(path) + costOf(excerpt);
            if (matches.length === SEARCH_MAX_MATCHES || used + cost > RESPONSE_BUDGET) {
                truncated = true;
                break;
            }
            if (excerpt.length < text!.length) truncated = true;
            matches.push({ path, line: Number(line), excerpt });
            used += cost;
        }
        return { commit, matches, truncated };
    }

    /** `HEAD` with no `ref`, else a branch, then a tag, of that exact name. Never revision syntax. */
    private async resolve(ref: string | undefined): Promise<string> {
        if (this.pinned !== undefined) {
            if (ref !== undefined) throw new CodeRefusal(`this reader is bound to commit ${this.pinned} and does not take a ref`, this.pinned);
            return this.pinned;
        }
        if (ref === undefined) {
            const head = await this.commitOf('HEAD');
            if (!head) throw new CodeRefusal('this project has no commits to read');
            return head;
        }
        const name = checkedRef(ref);
        const commit = (await this.commitOf(`refs/heads/${name}`)) ?? (await this.commitOf(`refs/tags/${name}`));
        if (!commit) throw new CodeRefusal(`there is no branch or tag named "${name}"`);
        return commit;
    }

    private async commitOf(ref: string): Promise<string | undefined> {
        try {
            const { stdout } = await this.exec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], GIT_BUFFER);
            return stdout.trim();
        } catch (err) {
            // `--quiet` makes a ref that does not exist exit 1 with nothing to say.
            if ((err as ExecFailure).code === 1) return undefined;
            throw refusalFrom(err);
        }
    }

    private async entryAt(commit: string, path: string): Promise<CodeEntry & { oid: string }> {
        const [entry] = parseEntries(await this.run(['ls-tree', '-z', '-l', commit, '--', path], commit));
        if (!entry) throw new CodeRefusal(`"${path}" does not exist at commit ${commit}`, commit);
        return entry;
    }

    private async run(args: string[], commit: string): Promise<string> {
        try {
            const { stdout } = await this.exec(args, GIT_BUFFER);
            return stdout;
        } catch (err) {
            throw refusalFrom(err, commit);
        }
    }

    /** `git grep`, where exit 1 is no matches and a full buffer is a result cut short, not a failure. */
    private async grep(args: string[], commit: string): Promise<{ stdout: string; cut: boolean }> {
        try {
            const { stdout } = await this.exec(args, SEARCH_BUFFER);
            return { stdout, cut: false };
        } catch (err) {
            const failure = err as ExecFailure;
            if (failure.code === 1) return { stdout: '', cut: false };
            if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { stdout: failure.stdout ?? '', cut: true };
            throw refusalFrom(err, commit);
        }
    }

    private exec(args: string[], maxBuffer: number) {
        return this.host.exec('git', ['--literal-pathspecs', ...args], { cwd: this.codeRoot, timeoutMs: GIT_TIMEOUT_MS, maxBuffer });
    }
}

const entryType = (mode: string): CodeEntryType => {
    if (mode === '120000') return 'symlink';
    if (mode === '160000') return 'submodule';
    if (mode === '040000') return 'directory';
    return 'file';
};

const parseEntries = (stdout: string): (CodeEntry & { oid: string })[] =>
    stdout
        .split('\0')
        .filter(Boolean)
        .map(line => {
            const [, mode, , oid, size, path] = TREE_ENTRY.exec(line) ?? [];
            if (!mode || !path) throw new Error(`could not parse ls-tree line: ${line}`);
            const type = entryType(mode);
            return {
                name: path.slice(path.lastIndexOf('/') + 1),
                path,
                type,
                oid: oid!,
                ...(type === 'file' && { size: Number(size) }),
            };
        });

/** The sentence for a git call that failed: over time, or git's own first line of explanation. */
const refusalFrom = (err: unknown, commit?: string): CodeRefusal => {
    const failure = err as ExecFailure;
    if (failure.killed)
        return new CodeRefusal(`reading this project's code hit the ${GIT_TIMEOUT_MS / 1000} second limit; narrow it and try again`, commit);
    const detail = failure.stderr?.trim().split('\n')[0] || failure.message;
    return new CodeRefusal(`could not read this project's code: ${detail}`, commit);
};
