import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { gitGrep } from '#modules/board/git.js';
import { localHost } from '#modules/host/local.execution.host.js';
import { findUnwiredSymbols, isExportScanned, scanExports } from '#modules/stages/unwired.symbols.js';

const exec = promisify(execFile);

describe('scanExports', () => {
    const names = (source: string, path = 'src/a.ts') => scanExports(path, source).map(symbol => symbol.name);

    it('finds each kind of declaration', () => {
        const source = [
            'export const a = 1;',
            'export function b() {}',
            'export class C {}',
            'export interface D {}',
            'export type E = string;',
            'export enum F {}',
            'export namespace G {}',
            'export const { h, i: [j] } = thing;',
        ].join('\n');
        expect(names(source)).toEqual(['a', 'b', 'C', 'D', 'E', 'F', 'G', 'h', 'j']);
    });

    it('finds an export list by the name it exports', () => {
        expect(names('const a = 1;\nexport { a as renamed };')).toEqual(['renamed']);
    });

    it('leaves out default exports and re-exports', () => {
        expect(
            names('export default function a() {}\nexport { b } from "./b";\nexport * from "./c";\nconst d = 1;\nexport { d as default };'),
        ).toEqual([]);
    });

    it('does not read a commented-out export or one in a string', () => {
        expect(names('// export const a = 1;\nconst s = "export const b = 2";')).toEqual([]);
    });

    it('records the line, and one entry for overloads', () => {
        const source = '\n\nexport function a(x: string): void;\nexport function a(x: number): void;\nexport function a(x: unknown) {}';
        expect(scanExports('src/a.ts', source).map(({ name, line }) => [name, line])).toEqual([['a', 3]]);
    });

    it('knows whether the file itself uses a name', () => {
        const source = 'export interface Options {}\nexport const run = (options: Options) => options;\nexport const alone = 1;';
        expect(Object.fromEntries(scanExports('src/a.ts', source).map(({ name, usedInFile }) => [name, usedInFile]))).toEqual({
            Options: true,
            run: false,
            alone: false,
        });
    });

    it('reads tsx, and a file with a syntax error without throwing', () => {
        expect(names('export const A = () => <div />;', 'src/a.tsx')).toEqual(['A']);
        expect(names('export const a = ;\nexport const b = 1;')).toContain('b');
    });
});

describe('isExportScanned', () => {
    it.each(['src/a.ts', 'src/a.tsx', 'apps/api/src/modules/x.service.ts'])('scans %s', path => {
        expect(isExportScanned(path)).toBe(true);
    });

    it.each([
        'src/a.test.ts',
        'tests/a.ts',
        'src/__mocks__/a.ts',
        'src/a.d.ts',
        'src/index.ts',
        'src/routes/home.tsx',
        'src/migrations/1_init.ts',
        'vite.config.ts',
        'src/a.js',
        'README.md',
    ])('leaves out %s', path => {
        expect(isExportScanned(path)).toBe(false);
    });
});

/** Real git: a base commit, then `branch` committed on top, and optionally `untracked` left uncommitted. */
const repoWith = async (base: Record<string, string>, branch: Record<string, string>, untracked: Record<string, string> = {}) => {
    const cwd = await mkdtemp(join(tmpdir(), 'unwired-symbols-'));
    const git = (...args: string[]) => exec('git', args, { cwd });
    const put = async (files: Record<string, string>) => {
        for (const [path, content] of Object.entries(files)) {
            await mkdir(dirname(join(cwd, path)), { recursive: true });
            await writeFile(join(cwd, path), content);
        }
    };
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 't@example.com');
    await git('config', 'user.name', 't');
    await put({ '.gitignore': 'ignored/\n', ...base });
    await git('add', '-A');
    await git('commit', '-q', '-m', 'base');
    const baseSha = (await git('rev-parse', 'HEAD')).stdout.trim();
    await put(branch);
    await git('add', '-A');
    await git('commit', '-q', '--allow-empty', '-m', 'work');
    await put(untracked);
    return { cwd, baseSha };
};

describe('gitGrep', () => {
    it('finds whole words in tracked and untracked files, but not ignored ones', async () => {
        const { cwd } = await repoWith({ 'a.ts': 'needle\n', 'b.ts': 'needles\n' }, {}, { 'c.ts': 'needle\n', 'ignored/d.ts': 'needle\n' });
        expect((await gitGrep(localHost, cwd, 'needle')).sort()).toEqual(['a.ts', 'c.ts']);
    });

    it('treats no matches as an empty answer, and honours exclusions', async () => {
        const { cwd } = await repoWith({ 'a.ts': 'needle\n' }, {});
        expect(await gitGrep(localHost, cwd, 'absent')).toEqual([]);
        expect(await gitGrep(localHost, cwd, 'needle', [':(exclude)a.ts'])).toEqual([]);
    });

    it('takes the word as fixed text', async () => {
        const { cwd } = await repoWith({ 'a.ts': 'a.c\nabc\n' }, {});
        expect(await gitGrep(localHost, cwd, 'a.c')).toEqual(['a.ts']);
        expect(await gitGrep(localHost, cwd, 'a..')).toEqual([]);
    });

    it('still throws for a real failure', async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'unwired-not-a-repo-'));
        await expect(gitGrep(localHost, join(cwd, 'gone'), 'needle')).rejects.toThrow();
    });
});

describe('findUnwiredSymbols', () => {
    const find = async (base: Record<string, string>, branch: Record<string, string>, untracked?: Record<string, string>) => {
        const { cwd, baseSha } = await repoWith(base, branch, untracked);
        return findUnwiredSymbols(localHost, cwd, baseSha);
    };

    it('finds a new export nothing calls, with where it is', async () => {
        expect(await find({}, { 'src/a.ts': '\nexport const orphan = 1;\n' })).toEqual([{ name: 'orphan', file: 'src/a.ts', line: 2 }]);
    });

    it('does not list one another file uses', async () => {
        expect(
            await find({}, { 'src/a.ts': 'export const wired = 1;\n', 'src/b.ts': "import { wired } from './a.js';\nconsole.log(wired);\n" }),
        ).toEqual([]);
    });

    it('does not count a test or a doc as a reference', async () => {
        const branch = {
            'src/a.ts': 'export const orphan = 1;\n',
            'tests/a.test.ts': 'orphan\n',
            'src/a.test.ts': 'orphan\n',
            'README.md': 'orphan\n',
        };
        expect((await find({}, branch)).map(symbol => symbol.name)).toEqual(['orphan']);
    });

    it('does not list an export its own file uses', async () => {
        expect(await find({}, { 'src/a.ts': 'export const helper = 1;\nexport const main = () => helper;\nmain();\n' })).toEqual([]);
    });

    it('does not list one that was already there, or one moved between changed files', async () => {
        const base = { 'src/a.ts': 'export const old = 1;\n', 'src/b.ts': 'export const moved = 1;\n' };
        expect(await find(base, { 'src/a.ts': 'export const old = 2;\n', 'src/b.ts': '', 'src/c.ts': 'export const moved = 1;\n' })).toEqual([]);
    });

    it('does not list one found without an import', async () => {
        expect(
            await find(
                {},
                {
                    'src/index.ts': 'export const api = 1;\n',
                    'src/routes/home.tsx': 'export const Route = 1;\n',
                    'tests/x.ts': 'export const t = 1;\n',
                },
            ),
        ).toEqual([]);
    });

    it('counts an untracked file as a reference', async () => {
        expect(await find({}, { 'src/a.ts': 'export const wired = 1;\n' }, { 'src/b.ts': 'wired\n' })).toEqual([]);
    });

    it('throws when the diff cannot be read, which the caller turns into could not compute', async () => {
        const { cwd } = await repoWith({}, {});
        await expect(findUnwiredSymbols(localHost, cwd, 'not-a-commit')).rejects.toThrow();
    });
});
