import { describe, expect, it } from 'vitest';
import { StageConfigService } from '#modules/stages/stage.config.service.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';

const VALID = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: build it
    onPass: merged
    onFail: implementing
`;

const OTHER_VALID = VALID.replace('build it', 'build it carefully');

const BROKEN_ROUTE = VALID.replace('onPass: merged', 'onPass: nowhere');

/**
 * `StageConfigService` is the thin layer `stages.ck` binds to: the store already validates and keeps
 * history, so what these pin is the translation at the HTTP edge — "no row" is a 404, a refused
 * document is a 400 carrying the validator's own sentence in `details.reason` (what
 * `wilson stages edit` prints), and a save with no message gets the default one.
 */
describe('StageConfigService', () => {
    it('answers get with the stored document', async () => {
        const service = new StageConfigService(new StaticStageConfigStore(VALID, 'seeded'));

        const document = await service.get();

        expect(document).toMatchObject({ yaml: VALID, message: 'seeded' });
    });

    it('answers 404, naming the fix, for a project with no stage config', async () => {
        const service = new StageConfigService(new StaticStageConfigStore());

        await expect(service.get()).rejects.toMatchObject({
            statusCode: 404,
            details: { reason: expect.stringContaining('wilson board init') },
        });
    });

    it('saves a valid document with the given message and returns it as the new current one', async () => {
        const store = new StaticStageConfigStore(VALID);
        const service = new StageConfigService(store);

        const saved = await service.set({ yaml: OTHER_VALID, message: 'be careful' });

        expect(saved).toMatchObject({ yaml: OTHER_VALID, message: 'be careful' });
        expect(await service.get()).toMatchObject({ id: saved.id });
        expect((await store.load()).stages[0]!.instructions).toBe('build it carefully');
    });

    it('records a save with no message (or a blank one) under the default message', async () => {
        const service = new StageConfigService(new StaticStageConfigStore(VALID));

        await service.set({ yaml: OTHER_VALID });
        await service.set({ yaml: VALID, message: '   ' });

        const versions = await service.versions({});
        expect(versions.map(v => v.message)).toEqual(['Edited stage config', 'Edited stage config', 'initial']);
    });

    it('refuses an invalid document with a 400 carrying the validator reason, writing nothing', async () => {
        const service = new StageConfigService(new StaticStageConfigStore(VALID));

        await expect(service.set({ yaml: BROKEN_ROUTE })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining('nowhere') },
        });
        await expect(service.set({ yaml: 'stages: [' })).rejects.toMatchObject({ statusCode: 400 });

        expect(await service.versions({})).toHaveLength(1);
    });

    it('lists versions newest first, honouring and capping limit', async () => {
        const service = new StageConfigService(new StaticStageConfigStore(VALID));
        await service.set({ yaml: OTHER_VALID, message: 'two' });
        await service.set({ yaml: VALID, message: 'three' });

        expect((await service.versions({})).map(v => v.message)).toEqual(['three', 'two', 'initial']);
        expect((await service.versions({ limit: 1 })).map(v => v.message)).toEqual(['three']);
        expect(await service.versions({ limit: 10_000 })).toHaveLength(3);
    });
});
