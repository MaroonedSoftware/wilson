import { describe, expect, it } from 'vitest';
import { LearningsService } from '#modules/learnings/learnings.service.js';
import { StaticLearningsStore } from '#modules/learnings/learnings.store.js';

/**
 * Card 0239. `LearningsService` is the thin layer `learnings.ck` binds to. Unlike
 * `StageConfigService`, it has no 404 and no 400 to translate: a project with no document answers
 * `get` with an empty one (AC3) rather than refusing, and `set` never refuses since `markdown` is
 * free text with no schema to fail against — what these pin is that translation (or lack of one),
 * plus the default message a save with none of its own gets.
 */
describe('LearningsService', () => {
    it('answers get with the stored document', async () => {
        const service = new LearningsService(new StaticLearningsStore('some learnings', 'seeded'));

        const document = await service.get();

        expect(document).toMatchObject({ markdown: 'some learnings', message: 'seeded' });
    });

    it('answers get with an empty document, not an error, for a project with no learnings yet (AC3)', async () => {
        const service = new LearningsService(new StaticLearningsStore());

        await expect(service.get()).resolves.toEqual({ markdown: '', message: '' });
    });

    it('saves a document with the given message and returns it as the new current one (AC1)', async () => {
        const store = new StaticLearningsStore('before');
        const service = new LearningsService(store);

        const saved = await service.set({ markdown: 'after', message: 'be careful' });

        expect(saved).toMatchObject({ markdown: 'after', message: 'be careful' });
        expect(await service.get()).toMatchObject({ id: saved.id, markdown: 'after' });
        expect(await store.load()).toBe('after');
    });

    it('accepts and saves an empty document, which becomes the current one (AC4)', async () => {
        const service = new LearningsService(new StaticLearningsStore('some learnings'));

        const saved = await service.set({ markdown: '', message: 'retire everything' });

        expect(saved.markdown).toBe('');
        await expect(service.get()).resolves.toMatchObject({ markdown: '' });
    });

    it('records a save with no message (or a blank one) under the default message', async () => {
        const service = new LearningsService(new StaticLearningsStore('seed'));

        await service.set({ markdown: 'a' });
        await service.set({ markdown: 'b', message: '   ' });

        const versions = await service.versions({});
        expect(versions.map(v => v.message)).toEqual(['Edited learnings', 'Edited learnings', 'initial']);
    });

    it('lists versions newest first, honouring and capping the limit (AC2)', async () => {
        const service = new LearningsService(new StaticLearningsStore('seed'));
        await service.set({ markdown: 'two', message: 'two' });
        await service.set({ markdown: 'three', message: 'three' });

        expect((await service.versions({})).map(v => v.message)).toEqual(['three', 'two', 'initial']);
        expect((await service.versions({ limit: 1 })).map(v => v.message)).toEqual(['three']);
        expect(await service.versions({ limit: 10_000 })).toHaveLength(3);
    });
});
