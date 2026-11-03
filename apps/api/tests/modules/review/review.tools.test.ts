import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatTool } from '#modules/chat/chat.tools.js';
import { CodeReader } from '#modules/code/code.reader.js';
import type { TourStep } from '#modules/review/review.repository.js';
import { MAX_TOOL_RESULT, reviewTools } from '#modules/review/review.tools.js';
import type { DiffFileEntry } from '#modules/worktree/worktree.manager.js';

const CHANGED: DiffFileEntry = {
    path: 'a.ts',
    status: 'modified',
    truncated: false,
    patch: ['@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three', ''].join('\n'),
};
const HUGE: DiffFileEntry = { path: 'huge.ts', status: 'modified', truncated: true, patch: '' };
const DENIED: DiffFileEntry = { path: '.env', status: 'modified', truncated: false, patch: '@@ -0,0 +1 @@\n+SECRET=1\n' };

/** Real git for the reader, because what these tools promise is what can be read at the bound commit. */
describe('reviewTools', () => {
    let root: string;
    let older: string;
    let reads: { operation: string; path?: string }[];
    let setTour: ReturnType<typeof vi.fn<(tour: TourStep[]) => Promise<void>>>;
    let tools: ChatTool[];

    const call = (name: string, input: Record<string, unknown> = {}) => tools.find(tool => tool.name === name)!.execute(input);

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'review-tools-'));
        const git = (...args: string[]) =>
            execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, encoding: 'utf8' }).trim();
        git('init', '-q');
        writeFileSync(join(root, 'a.ts'), 'one\nTWO\nthree\n');
        writeFileSync(join(root, 'other.ts'), 'first\nsecond\n');
        writeFileSync(join(root, 'big.ts'), `${'x'.repeat(MAX_TOOL_RESULT + 10)}\n`);
        git('add', '.');
        git('commit', '-qm', 'first');
        older = git('rev-parse', 'HEAD');
        writeFileSync(join(root, 'other.ts'), 'moved on\n');
        writeFileSync(join(root, 'later.ts'), 'not at the reviewed commit\n');
        git('add', '.');
        git('commit', '-qm', 'second');
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    beforeEach(() => {
        reads = [];
        setTour = vi.fn(async () => {});
        tools = reviewTools({
            files: [CHANGED, HUGE, DENIED],
            reader: new CodeReader(root, undefined, older),
            audited: async (operation, query, run) => {
                reads.push({ operation, path: query.path });
                return run();
            },
            setTour,
        });
    });

    it('offers nothing that writes to the project', () => {
        expect(tools.map(tool => tool.name).sort()).toEqual([
            'list_changed_files',
            'list_directory',
            'read_change',
            'read_file',
            'search_code',
            'set_tour',
        ]);
    });

    it('lists the change, marking what is too large or denied', async () => {
        expect(JSON.parse(await call('list_changed_files'))).toEqual([
            { path: 'a.ts', status: 'modified' },
            { path: 'huge.ts', status: 'modified', truncated: true },
            { path: '.env', status: 'modified', denied: true },
        ]);
    });

    it("reads a changed file's patch, but not a denied one, or one outside the change", async () => {
        expect(await call('read_change', { path: 'a.ts' })).toContain('+TWO');
        expect(await call('read_change', { path: '.env' })).not.toContain('SECRET');
        expect(await call('read_change', { path: 'other.ts' })).toContain('not part of this change');
    });

    it('reads code at the bound commit, on the record', async () => {
        expect(JSON.parse(await call('read_file', { path: 'other.ts' }))).toMatchObject({
            commit: older,
            content: expect.stringContaining('first\nsecond'),
        });
        expect(await call('read_file', { path: 'later.ts' })).toContain('Refused');
        expect(reads).toEqual([
            { operation: 'read', path: 'other.ts' },
            { operation: 'read', path: 'later.ts' },
        ]);
    });

    it('answers a denied read with a refusal rather than ending the turn', async () => {
        expect(await call('read_file', { path: '.env' })).toContain('deny list');
    });

    it('cuts an answer too large for the agent, and says so', async () => {
        const answer = await call('read_file', { path: 'big.ts' });

        expect(answer.length).toBeLessThan(MAX_TOOL_RESULT + 200);
    });

    describe('set_tour', () => {
        const anchor = (overrides: Record<string, unknown>) => ({ file: 'a.ts', side: 'new', startLine: 2, endLine: 2, ...overrides });
        const tour = (...anchors: unknown[]) => ({ steps: [{ title: 'Step', explanation: 'Why', anchors }] });
        const statuses = () => setTour.mock.calls[0]![0][0]!.anchors.map(stored => stored.status);

        it('marks a line the diff shows as in-diff, on either side', async () => {
            await call('set_tour', tour(anchor({}), anchor({ side: 'old', startLine: 2, endLine: 2 })));

            expect(statuses()).toEqual(['in-diff', 'in-diff']);
        });

        it('takes a range that only overlaps the diff as in-diff', async () => {
            await call('set_tour', tour(anchor({ startLine: 3, endLine: 40 })));

            expect(statuses()).toEqual(['in-diff']);
        });

        it('keeps real code the change did not touch as outside-diff', async () => {
            await call('set_tour', tour(anchor({ file: 'other.ts', startLine: 1, endLine: 2 })));

            expect(statuses()).toEqual(['outside-diff']);
        });

        it('keeps a place in a file whose diff is too large as truncated', async () => {
            await call('set_tour', tour(anchor({ file: 'huge.ts' })));

            expect(statuses()).toEqual(['truncated']);
        });

        it.each([
            ['a file not at the commit', anchor({ file: 'later.ts' }), 'later.ts'],
            ['a line past the end of the file', anchor({ file: 'other.ts', startLine: 1, endLine: 99 }), 'no line 99'],
            ['an old-side line the diff does not show', anchor({ side: 'old', startLine: 50, endLine: 50 }), 'not a removed line'],
            ['a backwards range', anchor({ startLine: 3, endLine: 1 }), 'is after endLine'],
            ['a denied file', anchor({ file: '.env', startLine: 1, endLine: 1 }), 'deny list'],
        ])('publishes nothing for %s, and says what to fix', async (_, bad, reason) => {
            const answer = await call('set_tour', tour(anchor({}), bad));

            expect(answer).toContain('Not published');
            expect(answer).toContain(reason);
            expect(setTour).not.toHaveBeenCalled();
        });

        it('accepts a step about no code in particular', async () => {
            expect(await call('set_tour', tour())).toBe('Published 1 step(s).');
        });
    });
});
