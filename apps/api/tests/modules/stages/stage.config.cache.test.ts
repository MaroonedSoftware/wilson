import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertRoutesResolve, findStage, loadStages, ProjectStagesSchema, StageConfigError } from '#modules/stages/stage.config.js';

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

    /**
     * Card 0031. `stages.yaml` routing to a state that does not exist is a `config-invalid` failure,
     * not a `stage-not-found` one — `assertRoutesResolve` fails the file itself, not a lookup for one
     * card's stage, so `classifyDispatchFailure` must defer it rather than poison the dispatching
     * card. This is the same distinction `findStage`'s own test pins from the other side.
     */
    it('rejects an invalid config as StageConfigError with kind "config-invalid", not "stage-not-found"', async () => {
        await writeFile(path, 'stages:\n  - name: implementing\n    onPass: nowhere\n    onFail: implementing\n', 'utf8');

        const error = await loadStages(boardRoot).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(StageConfigError);
        expect((error as StageConfigError).kind).toBe('config-invalid');
    });

    it('throws rather than serving a cached value once the file is gone', async () => {
        await loadStages(boardRoot);
        const { rm } = await import('node:fs/promises');
        await rm(path);

        await expect(loadStages(boardRoot)).rejects.toBeInstanceOf(StageConfigError);
    });

    /**
     * A missing `stages.yaml` is the same "the file itself is broken" failure as an invalid one — not
     * a per-card `stage-not-found` failure — so it must carry `kind: 'config-invalid'` too, for
     * `classifyDispatchFailure` to defer it rather than poisoning the card that happened to dispatch
     * first.
     */
    it('tags a missing stages.yaml as "config-invalid", so a dispatch defers rather than poisons', async () => {
        await loadStages(boardRoot);
        const { rm } = await import('node:fs/promises');
        await rm(path);

        const error = await loadStages(boardRoot).catch((err: unknown) => err);

        expect(error).toBeInstanceOf(StageConfigError);
        expect((error as StageConfigError).kind).toBe('config-invalid');
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

/**
 * Card 0031. `StageConfigError` used to be one flat class with no way to tell "this job named a
 * stage that does not exist" (a fact about this one card, deterministic, poisons) apart from
 * "stages.yaml itself will not load" (a fact about the file, true for every card, defers). Both
 * `findStage` and `assertRoutesResolve` throw the same class, so what has to be pinned is the `kind`
 * each throw site sets — `classifyDispatchFailure` branches on nothing else.
 */
describe('StageConfigError.kind distinguishes a missing stage from a broken config', () => {
    const stages = ProjectStagesSchema.parse({
        stages: [{ name: 'implementing', mode: 'agent', model: 'claude-opus', instructions: 'do it', onPass: 'merged', onFail: 'implementing' }],
    });

    it('tags a stage lookup miss as "stage-not-found", naming the stage that was looked up and the stages that do exist', () => {
        expect(() => findStage(stages, 'reviewing')).toThrow(StageConfigError);

        const error = (() => {
            try {
                findStage(stages, 'reviewing');
            } catch (err) {
                return err as StageConfigError;
            }
            throw new Error('expected findStage to throw');
        })();

        expect(error.kind).toBe('stage-not-found');
        expect(error.message).toContain('reviewing');
        expect(error.message).toContain('implementing');
    });

    it('tags a dangling route as "config-invalid", not "stage-not-found"', () => {
        const brokenRoutes = ProjectStagesSchema.parse({
            stages: [{ name: 'implementing', mode: 'agent', model: 'claude-opus', instructions: 'do it', onPass: 'nowhere', onFail: 'implementing' }],
        });

        const error = (() => {
            try {
                assertRoutesResolve(brokenRoutes);
            } catch (err) {
                return err as StageConfigError;
            }
            throw new Error('expected assertRoutesResolve to throw');
        })();

        expect(error).toBeInstanceOf(StageConfigError);
        expect(error.kind).toBe('config-invalid');
    });
});
