import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { collateralPaths } from '#modules/agent/collateral.js';

const exec = promisify(execFile);

/**
 * `collateralPaths` shells out to `git ls-files` to expand the (possibly glob) `scoped` list against
 * the worktree's tracked files, so every scenario below needs a real git repo on disk, not just a
 * plain directory. Files are left untracked deliberately: `--others --exclude-standard` picks those
 * up without a `git add`, and nothing here cares about history.
 */
describe('collateralPaths', () => {
    let root: string;

    const write = async (relPath: string, content: string) => {
        const absolute = join(root, relPath);
        await mkdir(join(absolute, '..'), { recursive: true });
        await writeFile(absolute, content, 'utf8');
    };

    beforeAll(async () => {
        const base = await mkdtemp(join(tmpdir(), 'collateral-'));
        root = join(base, 'worktree');
        await mkdir(root, { recursive: true });
        await exec('git', ['init'], { cwd: root });

        // Relative import, written with the `.js` extension this codebase uses on TS imports.
        await write('src/a.ts', "import { b } from './b.js';\nexport const a = b;\n");
        await write('src/b.ts', 'export const b = 1;\n');

        // `export ... from` is collateral too, not just `import ... from`.
        await write('src/c.ts', "export { d } from './d.js';\n");
        await write('src/d.ts', 'export const d = 1;\n');

        // One hop only: h imports i, and i imports j. Scoping h must not pull in j.
        await write('src/h.ts', "import { i } from './i.js';\n");
        await write('src/i.ts', "import { j } from './j.js';\nexport const i = j;\n");
        await write('src/j.ts', 'export const j = 1;\n');

        // A bare package specifier and a node builtin: neither is first-party.
        await write('src/e.ts', "import { z } from 'zod';\nimport { readFile } from 'node:fs/promises';\n");

        // A relative import that climbs above the worktree root. `outside.ts` exists (one level
        // above `root`) so this proves the containment check drops it, not merely that the target
        // is missing.
        await writeFile(join(base, 'outside.ts'), 'export const outside = 1;\n', 'utf8');
        await write('src/f.ts', "import { outside } from '../../outside.js';\n");

        // The project's `#modules/` subpath alias, resolved against `apps/api/src/` — mirrors the
        // real repo layout this project's own imports use.
        await write('apps/api/src/modules/agent/x.ts', "import { one } from '#modules/events/one.js';\n");
        await write('apps/api/src/modules/events/one.ts', 'export const one = 1;\n');

        // Two scoped files that both import the same collateral file, plus a second, distinct
        // collateral file — proves de-duplication and sorted output together.
        await write('src/dup/p.ts', "import { shared } from './shared.js';\n");
        await write('src/dup/q.ts', "import { shared } from './shared.js';\nimport { other } from './zzz.js';\n");
        await write('src/dup/shared.ts', 'export const shared = 1;\n');
        await write('src/dup/zzz.ts', 'export const other = 1;\n');

        // A non-TypeScript scoped file: read only `.ts`/`.tsx`.
        await write('src/readme.md', "import stuff from './b.js';\n");

        // A dynamic import has no `from` clause and must not be treated as collateral.
        await write('src/dyn.ts', "const mod = await import('./lazy.js');\n");
        await write('src/lazy.ts', 'export const lazy = 1;\n');
    });

    it('resolves a relative import with a rewritten .js -> .ts extension', async () => {
        await expect(collateralPaths(root, ['src/a.ts'])).resolves.toEqual(['src/b.ts']);
    });

    it('resolves an `export ... from` specifier the same as `import ... from`', async () => {
        await expect(collateralPaths(root, ['src/c.ts'])).resolves.toEqual(['src/d.ts']);
    });

    it('goes exactly one hop: does not pull in the collateral file’s own imports', async () => {
        const result = await collateralPaths(root, ['src/h.ts']);
        expect(result).toEqual(['src/i.ts']);
        expect(result).not.toContain('src/j.ts');
    });

    it('drops a bare package specifier and a node: builtin as not first-party', async () => {
        await expect(collateralPaths(root, ['src/e.ts'])).resolves.toEqual([]);
    });

    it('drops an import that resolves outside the worktree even though the target exists', async () => {
        await expect(collateralPaths(root, ['src/f.ts'])).resolves.toEqual([]);
    });

    it('resolves this project’s #modules/ subpath alias against apps/api/src/', async () => {
        await expect(collateralPaths(root, ['apps/api/src/modules/agent/x.ts'])).resolves.toEqual([
            'apps/api/src/modules/events/one.ts',
        ]);
    });

    it('de-duplicates a collateral file shared by two scoped files and sorts the result', async () => {
        await expect(collateralPaths(root, ['src/dup/p.ts', 'src/dup/q.ts'])).resolves.toEqual(['src/dup/shared.ts', 'src/dup/zzz.ts']);
    });

    it('skips a scoped file that is not .ts or .tsx', async () => {
        await expect(collateralPaths(root, ['src/readme.md'])).resolves.toEqual([]);
    });

    it('does not follow a dynamic import() expression', async () => {
        await expect(collateralPaths(root, ['src/dyn.ts'])).resolves.toEqual([]);
    });

    it('ignores a scoped entry naming a file that does not exist on disk', async () => {
        await expect(collateralPaths(root, ['src/does-not-exist.ts'])).resolves.toEqual([]);
    });

    it('expands a glob against the worktree’s tracked files before resolving imports', async () => {
        // `Files in scope` can be a glob rather than a literal path; `src/dup/*.ts` should sweep in
        // both p.ts and q.ts and produce the same union as naming them explicitly.
        await expect(collateralPaths(root, ['src/dup/*.ts'])).resolves.toEqual(['src/dup/shared.ts', 'src/dup/zzz.ts']);
    });

    it('returns nothing for a scope with no structural dependencies', async () => {
        await expect(collateralPaths(root, ['src/b.ts'])).resolves.toEqual([]);
    });
});
