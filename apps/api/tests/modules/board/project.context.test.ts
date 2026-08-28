import { describe, expect, it } from 'vitest';
import { currentProject, runAsProject } from '#modules/board/project.context.js';

/**
 * Card 0149. `project.context.ts` is the resolution mechanism the card's Constraints require: an
 * `AsyncLocalStorage`-backed ambient context, chosen (per that file's doc comment) over a DI scope or
 * a threaded parameter specifically because it lets the *same* `BoardConfig` instance every one of
 * the 34 existing consumers already holds answer differently depending on which project's work is
 * currently on the call stack — with zero change to any of those 34 files.
 *
 * These tests go straight at `runAsProject`/`currentProject` rather than at `Poller`/`CardStageJob`,
 * because the property that actually justifies "ambient context over a shared mutable variable" is
 * concurrency isolation: two units of work naming different projects, interleaved on the event loop,
 * must never see each other's project. A plain module-level `let currentProject` would fail exactly
 * that test while still passing every single-call test below — this file is built around the
 * distinction on purpose.
 */
describe('project.context', () => {
    it('reports undefined when nothing has ever called runAsProject', () => {
        expect(currentProject()).toBeUndefined();
    });

    it('reports the project name for the duration of the runAsProject callback', async () => {
        let seenInside: string | undefined;

        await runAsProject('alpha', async () => {
            seenInside = currentProject();
        });

        expect(seenInside).toBe('alpha');
    });

    it('reverts to undefined once the runAsProject callback has settled', async () => {
        await runAsProject('alpha', async () => {
            /* no-op */
        });

        expect(currentProject()).toBeUndefined();
    });

    it('reverts to undefined even when the callback throws, rather than leaking the project onto later work', async () => {
        await expect(
            runAsProject('alpha', async () => {
                throw new Error('stage failed');
            }),
        ).rejects.toThrow('stage failed');

        expect(currentProject()).toBeUndefined();
    });

    it('propagates the callback return value through runAsProject', async () => {
        const result = await runAsProject('alpha', async () => 42);

        expect(result).toBe(42);
    });

    it('nests correctly: an inner runAsProject shadows the outer one, and the outer project is restored once the inner settles', async () => {
        const seen: Array<string | undefined> = [];

        await runAsProject('outer', async () => {
            seen.push(currentProject());
            await runAsProject('inner', async () => {
                seen.push(currentProject());
            });
            seen.push(currentProject());
        });

        expect(seen).toEqual(['outer', 'inner', 'outer']);
    });

    /**
     * The whole reason this card rejected a plain module-level variable (see `project.context.ts`'s
     * doc comment, "Rejected: threading a project parameter" section, and the class-level comment on
     * `ProjectScopedBoardConfig` about "every read... answers differently... based on which project's
     * work is currently on the call stack"): `Poller.tick` walks every registered project inside one
     * process, one after another, but a `card.stage` job dispatched by `CardStageJob` can genuinely
     * overlap another one in flight — two `card.stage` handlers running concurrently, each for a
     * different project. A naive "set before, unset after" global would let the first job's `finally`
     * clear the *second* job's still-running project out from under it. `AsyncLocalStorage.run`
     * cannot do that: each call gets its own isolated store, so two `runAsProject` calls interleaved
     * on the event loop never see each other's value, even while both are genuinely in flight at once.
     */
    it('keeps two concurrently in-flight runAsProject calls fully isolated from each other', async () => {
        const seenA: Array<string | undefined> = [];
        const seenB: Array<string | undefined> = [];

        const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

        const taskA = runAsProject('project-a', async () => {
            seenA.push(currentProject());
            await delay(20);
            // If the context were a shared mutable variable rather than genuinely ambient storage,
            // task B's own runAsProject call (below) would have overwritten it by the time this
            // resumes from the delay.
            seenA.push(currentProject());
        });

        const taskB = runAsProject('project-b', async () => {
            seenB.push(currentProject());
            await delay(5);
            seenB.push(currentProject());
        });

        await Promise.all([taskA, taskB]);

        expect(seenA).toEqual(['project-a', 'project-a']);
        expect(seenB).toEqual(['project-b', 'project-b']);
        expect(currentProject()).toBeUndefined();
    });
});
