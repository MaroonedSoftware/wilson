import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOB_MAX_BYTES, CodeReader, CodeRefusal, GIT_TIMEOUT_MS, SEARCH_EXCERPT_LENGTH, SEARCH_MAX_MATCHES } from '#modules/code/code.reader.js';
import { RESULT_CAP } from '#modules/chat/chat.tools.js';
import type { ExecutionHost } from '#modules/host/execution.host.js';

const DENIED_FILES = [
    '.env',
    'config/.env.local',
    'deep/er/.ENV',
    'certs/server.pem',
    'certs/SERVER.PEM2.pem',
    'a/b/tls.key',
    'store.p12',
    'nested/store.PFX',
    'keys/id_rsa',
    'keys/id_rsa.pub',
    'keys/ID_ED25519',
    '.npmrc',
    'pkg/.netrc',
    'secrets.key/inner.txt',
];

const refusalOf = async (read: Promise<unknown>): Promise<CodeRefusal> => {
    const failure = await read.then(
        result => {
            throw new Error(`expected a refusal, got ${JSON.stringify(result).slice(0, 200)}`);
        },
        (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(CodeRefusal);
    return failure as CodeRefusal;
};

/**
 * `CodeReader` against a real repository, since what it promises is about what git does with the
 * arguments it is handed: that a hostile ref runs nothing, that a symlink is not followed, and that
 * nothing in the checkout moves.
 */
describe('CodeReader', () => {
    let root: string;
    let outside: string;
    let reader: CodeReader;
    let head: string;
    let older: string;

    const run = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' }).trim();
    const write = (path: string, content: string | Buffer) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
    };

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'code-reader-'));
        outside = mkdtempSync(join(tmpdir(), 'code-reader-outside-'));
        writeFileSync(join(outside, 'target.txt'), 'outside needle\n');
        run('init', '-q', '-b', 'main');
        write('README.md', 'first version\n');
        run('add', '.');
        run('commit', '-qm', 'first');
        older = run('rev-parse', 'HEAD');
        run('tag', 'v1');
        run('branch', 'feature/thing');

        write('README.md', 'second version needle\n');
        write('src/app.ts', 'export const needle = 1;\nconst other = 2;\n-dash line\n');
        write(':(glob)odd', 'a file whose name is pathspec magic\n');
        write('many.txt', 'needle\n'.repeat(SEARCH_MAX_MATCHES + 50));
        write('long-match.txt', `needle ${'x'.repeat(SEARCH_EXCERPT_LENGTH * 2)}\n`);
        write('paged.txt', Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${'y'.repeat(40)}`).join('\n') + '\n');
        write('quotes.txt', `${'"'.repeat(500)}\n`.repeat(100));
        write('minified.js', `${'z'.repeat(50_000)}\nafter\n`);
        write('empty.txt', '');
        write('binary.bin', Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01, 0x02]));
        write('huge.txt', 'h'.repeat(BLOB_MAX_BYTES + 1));
        for (const file of DENIED_FILES) write(file, 'needle secret\n');
        for (const file of ['.environment', 'notes.keyboard', 'id_rs', '.gitignore']) write(file, 'fine\n');
        symlinkSync(join(outside, 'target.txt'), join(root, 'escape'));
        symlinkSync('src/app.ts', join(root, 'inside'));
        run('add', '.');
        run('commit', '-qm', 'second');
        head = run('rev-parse', 'HEAD');
        reader = new CodeReader(root);
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
    });

    describe('listing', () => {
        it('lists the root at HEAD, naming the commit', async () => {
            const { commit, path, entries } = await reader.list({});

            expect(commit).toBe(head);
            expect(path).toBe('');
            expect(entries).toContainEqual({ name: 'README.md', path: 'README.md', type: 'file', size: 22 });
            expect(entries.find(entry => entry.name === 'src')).toMatchObject({ type: 'directory' });
        });

        it('lists a subdirectory, with or without a trailing slash', async () => {
            const plain = await reader.list({ path: 'src' });

            expect(plain.entries.map(entry => entry.path)).toEqual(['src/app.ts']);
            expect((await reader.list({ path: 'src/' })).entries).toEqual(plain.entries);
        });

        it('shows a symlink as one, without its target', async () => {
            const { entries } = await reader.list({});
            const link = entries.find(entry => entry.name === 'escape');

            expect(link).toMatchObject({ type: 'symlink' });
            expect(JSON.stringify(entries)).not.toContain(outside);
        });

        it('marks a denied entry rather than hiding it', async () => {
            const { entries } = await reader.list({});

            expect(entries.find(entry => entry.name === '.env')).toMatchObject({ denied: true });
            expect(entries.find(entry => entry.name === 'secrets.key')).toMatchObject({ denied: true });
            expect(entries.find(entry => entry.name === 'README.md')?.denied).toBeUndefined();
        });

        it('refuses a file, a missing path and a denied directory', async () => {
            expect((await refusalOf(reader.list({ path: 'README.md' }))).reason).toContain('not a directory');
            expect((await refusalOf(reader.list({ path: 'nope' }))).reason).toContain('does not exist');
            expect((await refusalOf(reader.list({ path: 'secrets.key' }))).reason).toContain('deny list');
        });
    });

    describe('paths', () => {
        it.each([
            ['/etc/passwd', 'absolute'],
            ['../outside', '".."'],
            ['src/../../outside', '".."'],
            ['src\0x', 'NUL'],
            ['src\\app.ts', 'backslash'],
            ['src//app.ts', 'empty segment'],
            ['nope.ts', 'does not exist'],
        ])('refuses %j', async (path, reason) => {
            for (const read of [() => reader.read({ path }), () => reader.list({ path }), () => reader.search({ pattern: 'x', path })]) {
                expect((await refusalOf(read())).reason).toContain(reason);
            }
        });

        it('takes pathspec magic literally', async () => {
            expect((await reader.read({ path: ':(glob)odd' })).content).toContain('pathspec magic');
            expect((await refusalOf(reader.read({ path: ':(glob)*' }))).reason).toContain('does not exist');
            expect((await refusalOf(reader.search({ pattern: 'needle', path: ':(glob)**' }))).reason).toContain('does not exist');
        });

        it('does not read through a symlinked directory or into the .git directory', async () => {
            expect((await refusalOf(reader.read({ path: 'inside/anything' }))).reason).toContain('does not exist');
            expect((await refusalOf(reader.read({ path: '.git/config' }))).reason).toContain('deny list');
        });
    });

    describe('the deny list', () => {
        it.each(DENIED_FILES)('refuses to read %s', async path => {
            expect((await refusalOf(reader.read({ path }))).reason).toContain('deny list');
        });

        it('drops every denied path from search results', async () => {
            const { matches } = await reader.search({ pattern: 'secret' });

            expect(matches).toEqual([]);
        });

        it('refuses a search scoped to a denied path', async () => {
            expect((await refusalOf(reader.search({ pattern: 'needle', path: 'certs/server.pem' }))).reason).toContain('deny list');
        });

        it.each(['.environment', 'notes.keyboard', 'id_rs', '.gitignore'])('still reads %s, which only resembles a denied name', async path => {
            expect((await reader.read({ path })).content).toBe('fine');
        });
    });

    describe('symlinks', () => {
        it.each(['escape', 'inside'])('refuses to read %s and does not return its target', async path => {
            const refusal = await refusalOf(reader.read({ path }));

            expect(refusal.reason).toContain('symlink');
            expect(refusal.reason).not.toContain(outside);
            expect(refusal.commit).toBe(head);
        });

        it('does not search a symlink', async () => {
            const { matches } = await reader.search({ pattern: 'target\\.txt|code-reader-outside' });

            expect(matches).toEqual([]);
        });
    });

    describe('refs', () => {
        it('reads a real branch, a real tag and a branch with a slash', async () => {
            expect(await reader.read({ path: 'README.md', ref: 'main' })).toMatchObject({ commit: head });
            expect(await reader.read({ path: 'README.md', ref: 'v1' })).toMatchObject({ commit: older, content: 'first version' });
            expect(await reader.read({ path: 'README.md', ref: 'feature/thing' })).toMatchObject({ commit: older });
        });

        it('runs nothing for a ref that would be a git grep option', async () => {
            const marker = join(root, 'pwned');

            for (const ref of ['-Otouch pwned', `-O${'touch'} ${marker}`, '--open-files-in-pager=touch pwned']) {
                expect((await refusalOf(reader.search({ pattern: 'needle', ref }))).reason).toContain('not a plain branch or tag');
            }

            expect(existsSync(marker)).toBe(false);
        });

        it.each(['HEAD~1', 'HEAD^', 'HEAD:config', 'main@{1}', 'a..b', '', '-x', '.hidden'])('refuses the revision syntax %j', async ref => {
            expect((await refusalOf(reader.read({ path: 'README.md', ref }))).reason).toContain('not a plain branch or tag');
        });

        it('refuses a bare commit id, and a name that exists as nothing', async () => {
            expect((await refusalOf(reader.read({ path: 'README.md', ref: older }))).reason).toContain('no branch or tag');
            expect((await refusalOf(reader.read({ path: 'README.md', ref: 'HEAD' }))).reason).toContain('no branch or tag');
            expect((await refusalOf(reader.read({ path: 'README.md', ref: 'nope' }))).reason).toContain('no branch or tag');
        });
    });

    describe('a pinned reader', () => {
        it('reads the commit it is bound to, not HEAD, and every read says so', async () => {
            const pinned = new CodeReader(root, undefined, older);

            expect(await pinned.read({ path: 'README.md' })).toMatchObject({ commit: older, content: 'first version' });
            expect((await pinned.list({})).commit).toBe(older);
            expect((await pinned.search({ pattern: 'first version' })).commit).toBe(older);
        });

        it('refuses any ref, so a caller cannot read past the commit it was given', async () => {
            const pinned = new CodeReader(root, undefined, older);

            expect((await refusalOf(pinned.read({ path: 'README.md', ref: 'main' }))).reason).toContain('bound to commit');
        });

        it('still refuses a path on the deny list', async () => {
            const pinned = new CodeReader(root, undefined, older);

            expect((await refusalOf(pinned.read({ path: '.env' }))).reason).toContain('deny list');
        });
    });

    describe('reading', () => {
        it('returns content by line, from an offset, up to a limit', async () => {
            expect(await reader.read({ path: 'src/app.ts', offset: 2, limit: 1 })).toEqual({
                commit: head,
                path: 'src/app.ts',
                content: 'const other = 2;',
                offset: 2,
                totalLines: 3,
                nextOffset: 3,
            });
        });

        it('reads an empty file', async () => {
            expect(await reader.read({ path: 'empty.txt' })).toMatchObject({ content: '', totalLines: 0 });
        });

        it('refuses an offset past the end, and one that is not a line number', async () => {
            expect((await refusalOf(reader.read({ path: 'src/app.ts', offset: 4 }))).reason).toContain('no line 4');
            expect((await refusalOf(reader.read({ path: 'src/app.ts', offset: 0 }))).reason).toContain('first line is 1');
            expect((await refusalOf(reader.read({ path: 'src/app.ts', limit: 0 }))).reason).toContain('limit');
        });

        const pageThrough = async (path: string) => {
            const lines: string[] = [];
            let offset: number | undefined = 1;
            let pages = 0;
            while (offset !== undefined) {
                const page: Awaited<ReturnType<CodeReader['read']>> = await reader.read({ path, offset });
                expect(JSON.stringify(page, null, 1).length).toBeLessThan(RESULT_CAP);
                lines.push(...page.content.split('\n'));
                offset = page.nextOffset;
                pages += 1;
            }
            return { lines, pages };
        };

        it('pages a large file to completion, each page under the chat cut', async () => {
            const { lines, pages } = await pageThrough('paged.txt');

            expect(pages).toBeGreaterThan(1);
            expect(lines).toHaveLength(5000);
            expect(lines[4999]).toContain('line 5000 ');
        });

        it('stays under the chat cut for a file that escapes badly', async () => {
            const { lines } = await pageThrough('quotes.txt');

            expect(lines).toHaveLength(100);
        });

        it('moves past a single line longer than a page, and says it was cut', async () => {
            const first = await reader.read({ path: 'minified.js' });

            expect(first.lineTruncated).toBe(true);
            expect(first.nextOffset).toBe(2);
            expect(first.content.length).toBeLessThan(50_000);
            expect(await reader.read({ path: 'minified.js', offset: first.nextOffset })).toMatchObject({ content: 'after', totalLines: 2 });
        });

        it('refuses a binary file and an oversized blob', async () => {
            expect((await refusalOf(reader.read({ path: 'binary.bin' }))).reason).toContain('binary');
            expect((await refusalOf(reader.read({ path: 'huge.txt' }))).reason).toContain('byte limit');
        });

        it('refuses an oversized blob from its recorded size, without reading it', async () => {
            const calls: string[][] = [];
            const counting = {
                exec: (file: string, args: readonly string[], options: Parameters<ExecutionHost['exec']>[2]) => {
                    calls.push([...args]);
                    return localHostExec(file, args, options);
                },
            } as unknown as ExecutionHost;

            await refusalOf(new CodeReader(root, counting).read({ path: 'huge.txt' }));

            expect(calls.some(args => args.includes('cat-file'))).toBe(false);
        });

        it('refuses a directory', async () => {
            expect((await refusalOf(reader.read({ path: 'src' }))).reason).toContain('not a file');
        });
    });

    describe('searching', () => {
        it('finds a pattern with its path and line, naming the commit', async () => {
            const { commit, matches, truncated } = await reader.search({ pattern: 'const needle', path: 'src' });

            expect(commit).toBe(head);
            expect(matches).toEqual([{ path: 'src/app.ts', line: 1, excerpt: 'export const needle = 1;' }]);
            expect(truncated).toBe(false);
        });

        it('treats a pattern starting with a dash as a pattern', async () => {
            const { matches } = await reader.search({ pattern: '-dash', path: 'src/app.ts' });

            expect(matches).toEqual([{ path: 'src/app.ts', line: 3, excerpt: '-dash line' }]);
        });

        it('runs nothing for a pattern that reads like an option', async () => {
            const marker = join(root, 'pwned-by-pattern');

            await reader.search({ pattern: `-O touch ${marker}` });

            expect(existsSync(marker)).toBe(false);
        });

        it('answers nothing for no matches, rather than failing', async () => {
            expect(await reader.search({ pattern: 'no-such-text-anywhere' })).toEqual({ commit: head, matches: [], truncated: false });
        });

        it('searches the ref it is given', async () => {
            const { commit, matches } = await reader.search({ pattern: 'version', ref: 'v1' });

            expect(commit).toBe(older);
            expect(matches).toEqual([{ path: 'README.md', line: 1, excerpt: 'first version' }]);
        });

        it('stops at the match limit, and says so', async () => {
            const { matches, truncated } = await reader.search({ pattern: 'needle', path: 'many.txt' });

            expect(matches).toHaveLength(SEARCH_MAX_MATCHES);
            expect(truncated).toBe(true);
        });

        it('cuts a long excerpt, and says so', async () => {
            const { matches, truncated } = await reader.search({ pattern: 'needle', path: 'long-match.txt' });

            expect(matches[0]?.excerpt).toHaveLength(SEARCH_EXCERPT_LENGTH);
            expect(truncated).toBe(true);
        });

        it('stays under the chat cut however many long matches there are', async () => {
            const result = await reader.search({ pattern: '.', path: 'quotes.txt' });

            expect(result.truncated).toBe(true);
            expect(JSON.stringify(result, null, 1).length).toBeLessThan(RESULT_CAP);
        });

        it('refuses an empty pattern', async () => {
            expect((await refusalOf(reader.search({ pattern: '' }))).reason).toContain('needs a pattern');
        });

        it('refuses a search that hits the time limit, and gives every git call that limit', async () => {
            const timeouts: (number | undefined)[] = [];
            const slowGrep = {
                exec: (file: string, args: readonly string[], options: Parameters<ExecutionHost['exec']>[2]) => {
                    timeouts.push(options.timeoutMs);
                    if (args.includes('grep')) return Promise.reject(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }));
                    return localHostExec(file, args, options);
                },
            } as unknown as ExecutionHost;

            const refusal = await refusalOf(new CodeReader(root, slowGrep).search({ pattern: '(a+)+$' }));

            expect(refusal.reason).toContain('second limit');
            expect(refusal.commit).toBe(head);
            expect(timeouts.every(timeout => timeout === GIT_TIMEOUT_MS)).toBe(true);
        });

        it('reports a search cut off by its output buffer as truncated, not failed', async () => {
            const header = `${head}:src/app.ts\x001\x00kept\n`;
            const flooded = {
                exec: (file: string, args: readonly string[], options: Parameters<ExecutionHost['exec']>[2]) =>
                    args.includes('grep')
                        ? Promise.reject(
                              Object.assign(new Error('too much'), {
                                  code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                                  killed: true,
                                  stdout: `${header}partial`,
                              }),
                          )
                        : localHostExec(file, args, options),
            } as unknown as ExecutionHost;

            expect(await new CodeReader(root, flooded).search({ pattern: 'kept' })).toEqual({
                commit: head,
                matches: [{ path: 'src/app.ts', line: 1, excerpt: 'kept' }],
                truncated: true,
            });
        });
    });

    describe('a repository it cannot read', () => {
        it('refuses a project with no commits', async () => {
            const empty = mkdtempSync(join(tmpdir(), 'code-reader-empty-'));
            try {
                execFileSync('git', ['init', '-q'], { cwd: empty });
                expect((await refusalOf(new CodeReader(empty).list({}))).reason).toContain('no commits');
            } finally {
                rmSync(empty, { recursive: true, force: true });
            }
        });

        it('refuses a code root that is not a repository, with a reason', async () => {
            const plain = mkdtempSync(join(tmpdir(), 'code-reader-plain-'));
            try {
                expect((await refusalOf(new CodeReader(plain).list({}))).reason).toContain('could not read');
            } finally {
                rmSync(plain, { recursive: true, force: true });
            }
        });
    });

    it('leaves the working tree, refs and HEAD exactly as they were', async () => {
        const snapshot = () => [
            run('status', '--porcelain', '--ignored'),
            run('for-each-ref'),
            run('symbolic-ref', 'HEAD'),
            run('rev-parse', 'HEAD'),
            run('worktree', 'list'),
        ];
        const before = snapshot();

        await reader.list({});
        await reader.list({ path: 'src', ref: 'main' });
        await reader.read({ path: 'README.md', ref: 'v1' });
        await reader.search({ pattern: 'needle', ref: 'feature/thing' });
        await refusalOf(reader.read({ path: 'escape' }));
        await refusalOf(reader.search({ pattern: 'x', ref: '-Otouch pwned' }));

        expect(snapshot()).toEqual(before);
    });
});

const localHostExec = async (file: string, args: readonly string[], options: Parameters<ExecutionHost['exec']>[2]) => {
    const { localHost } = await import('#modules/host/local.execution.host.js');
    return localHost.exec(file, args, options);
};
