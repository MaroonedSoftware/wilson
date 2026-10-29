import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import type { ExecutionHost } from '#modules/host/execution.host.js';
import { localHost } from '#modules/host/local.execution.host.js';

/**
 * `apps/api/tsconfig.json`'s `paths`, hardcoded here rather than read at runtime: this is the only
 * package these subpaths resolve against, and the mapping only changes if the tsconfig itself does.
 */
const SUBPATH_ALIASES: Array<readonly [prefix: string, base: string]> = [
    ['#modules/', 'apps/api/src/modules/'],
    ['#shared/', 'apps/api/src/shared/'],
    ['#src/', 'apps/api/src/'],
];

// Matches `import ... from '<spec>'` and `export ... from '<spec>'`, including multi-line named
// imports — the character class excludes only the quotes and the statement terminator, so it still
// crosses newlines between `import {` and `} from '...'`. Deliberately does not match `import(...)`:
// dynamic import has no `from` clause for this to anchor on.
const IMPORT_RE = /\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g;

/** This codebase writes `.js` extensions on TypeScript imports; the file on disk is the `.ts`. */
const withTsExtension = (path: string): string => (path.endsWith('.js') ? `${path.slice(0, -3)}.ts` : path);

/** Resolve one import specifier to an absolute path, or `undefined` for anything not first-party. */
const resolveSpecifier = (worktreeRoot: string, importerAbsolute: string, spec: string): string | undefined => {
    if (spec.startsWith('./') || spec.startsWith('../')) {
        return withTsExtension(resolve(dirname(importerAbsolute), spec));
    }
    const alias = SUBPATH_ALIASES.find(([prefix]) => spec.startsWith(prefix));
    if (alias) {
        const [prefix, base] = alias;
        return withTsExtension(resolve(worktreeRoot, base, spec.slice(prefix.length)));
    }
    // A bare specifier: a package name, a `node:` builtin, or an alias this project does not
    // declare. None of those are first-party.
    return undefined;
};

/**
 * `scoped` may hold globs, since it comes straight from a card's `Files in scope`. Expand against
 * the worktree's tracked files rather than walking the filesystem — the same source the glob tool
 * already uses, and the cheapest way to enumerate them.
 */
const expandScoped = async (host: ExecutionHost, worktreeRoot: string, scoped: string[]): Promise<string[]> => {
    const result = await host
        .exec('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
            cwd: worktreeRoot,
            maxBuffer: 8 * 1024 * 1024,
        })
        .catch((err: Error) => err);
    if (result instanceof Error) return [];

    const tracked = result.stdout.split('\n').filter(Boolean);
    const isScoped = picomatch(scoped, { dot: true });
    return tracked.filter(path => isScoped(path));
};

const exists = async (host: ExecutionHost, path: string): Promise<boolean> =>
    host
        .stat(path)
        .then(() => true)
        .catch(() => false);

/**
 * The files a card's scoped files structurally depend on, one hop out.
 *
 * Derived from the code every time this is called, never from history or a saved list: a scoped
 * file's own static imports, resolved and containment-checked against the worktree, are the only
 * source of truth for what is collateral. Relative specifiers and this project's `#modules/`,
 * `#shared/` and `#src/` subpath imports are resolved; anything else (a package, a `node:` builtin,
 * an import that resolves outside the worktree) is dropped rather than treated as collateral.
 *
 * Read on `host`, the machine the worktree is on; this one unless a caller says otherwise.
 */
export const collateralPaths = async (worktreeRoot: string, scoped: string[], host: ExecutionHost = localHost): Promise<string[]> => {
    const files = await expandScoped(host, worktreeRoot, scoped);
    const collateral = new Set<string>();

    for (const file of files) {
        if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;

        const absolute = resolve(worktreeRoot, file);
        const source = await host.readFile(absolute).catch(() => undefined);
        if (source === undefined) continue;

        for (const match of source.matchAll(IMPORT_RE)) {
            const spec = match[1];
            if (spec === undefined) continue;
            const resolved = resolveSpecifier(worktreeRoot, absolute, spec);
            if (!resolved || !(await exists(host, resolved))) continue;

            const rel = relative(worktreeRoot, resolved);
            if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
            collateral.add(rel.split(sep).join('/'));
        }
    }

    return [...collateral].sort();
};
