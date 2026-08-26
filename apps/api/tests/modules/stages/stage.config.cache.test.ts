import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadStages, StageConfigError } from '#modules/stages/stage.config.js';

/**
 * `loadStages` is called twice for the same file on every dispatch (`StageDispatcher.run` and
 * `CardStageJob.runStage`), on every poller tick, and from several API routes — each one a read, a
 * YAML parse, a zod validation and a route check of a file that changes only when a human edits it.
 *
 * The guard is the file's own mtime and size rather than a timeout, because "stages are config, not
 * code" (PROJECT.md decision 7) means an operator edits this on a running daemon and the next
 * dispatch has to see it. These pin both halves: that repeats are served from the cache, and that
 * every way the file can change still gets through.
 */
const VALID = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: build it
    onPass: merged
    onFail: implementing
`;

const OTHER_VALID = `
stages:
  - name: reviewing
    mode: agent
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: reviewing
`;

describe('loadStages caches on file identity', () => {
    let boardRoot: string;
    let path: string;

    beforeEach(async () => {
        boardRoot = await mkdtemp(join(tmpdir(), 'stage-config-cache-'));
        await mkdir(join(boardRoot, 'config'), { recursive: true });
        path = join(boardRoot, 'config', 'stages.yaml');
        await writeFile(path, VALID, 'utf8');
    });

    it('returns the very same object on a repeat load of an unchanged file', async () => {
        const first = await loadStages(boardRoot);
        const second = await loadStages(boardRoot);

        expect(second).toBe(first);
    });

    it('re-reads once the file has a newer mtime', async () => {
        const first = await loadStages(boardRoot);
        expect(first.stages[0]!.name).toBe('implementing');

        await writeFile(path, OTHER_VALID, 'utf8');
        // Set the mtime explicitly rather than trusting that a rewrite lands in a different
        // millisecond: what is under test is that a changed mtime invalidates, not the filesystem's
        // timestamp resolution.
        const later = new Date(Date.now() + 2000);
        await utimes(path, later, later);

        const second = await loadStages(boardRoot);
        expect(second).not.toBe(first);
        expect(second.stages[0]!.name).toBe('reviewing');
    });

    /**
     * Size is checked as well as mtime, so an edit that somehow lands on the same timestamp — a
     * restored backup, a tool that preserves mtime — is not served from the cache anyway.
     */
    it('re-reads when the size changed even if the mtime did not', async () => {
        const first = await loadStages(boardRoot);

        const pinned = new Date(Date.now() - 5000);
        await utimes(path, pinned, pinned);
        await loadStages(boardRoot);

        await writeFile(path, `${OTHER_VALID}\n# a comment that changes the size\n`, 'utf8');
        await utimes(path, pinned, pinned);

        const second = await loadStages(boardRoot);
        expect(second).not.toBe(first);
        expect(second.stages[0]!.name).toBe('reviewing');
    });

    /**
     * The operator fixing a broken config is exactly the case that must not be served a remembered
     * answer — and there is nothing to remember, because a failed load never reaches the cache.
     */
    it('keeps throwing for an invalid config, and picks up the fix', async () => {
        await writeFile(path, 'stages:\n  - name: implementing\n    onPass: nowhere\n', 'utf8');
        await expect(loadStages(boardRoot)).rejects.toBeInstanceOf(StageConfigError);
        await expect(loadStages(boardRoot)).rejects.toBeInstanceOf(StageConfigError);

        await writeFile(path, VALID, 'utf8');
        const later = new Date(Date.now() + 2000);
        await utimes(path, later, later);

        await expect(loadStages(boardRoot)).resolves.toMatchObject({ stages: [{ name: 'implementing' }] });
    });

    it('throws rather than serving a cached value once the file is gone', async () => {
        await loadStages(boardRoot);
        const { rm } = await import('node:fs/promises');
        await rm(path);

        await expect(loadStages(boardRoot)).rejects.toBeInstanceOf(StageConfigError);
    });

    /**
     * Every caller now shares one instance where each used to get its own parse. Freezing makes that
     * safe by construction rather than by every future caller happening not to mutate what it got.
     */
    it('hands back a deeply frozen config', async () => {
        const stages = await loadStages(boardRoot);

        expect(Object.isFrozen(stages)).toBe(true);
        expect(Object.isFrozen(stages.stages)).toBe(true);
        expect(Object.isFrozen(stages.stages[0])).toBe(true);
        expect(() => {
            (stages.stages[0] as { name: string }).name = 'mutated';
        }).toThrow(TypeError);
    });
});
