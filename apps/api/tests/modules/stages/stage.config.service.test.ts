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

/**
 * `StageConfigService` is the thin layer `stages.ck` binds to: the store already validates and keeps
 * history, so what these pin is the translation at the HTTP edge: no lanes is a 404, and a refused
 * change is a 400 carrying the validator's own sentence in `details.reason`, which is what
 * `wilson stages set` prints.
 */
describe('StageConfigService', () => {
    it('lists lanes, and answers 404 for a project with none', async () => {
        const service = new StageConfigService(new StaticStageConfigStore(VALID));

        expect((await service.lanes()).map(lane => lane.name)).toEqual(['implementing']);
        await expect(new StageConfigService(new StaticStageConfigStore()).lanes()).rejects.toMatchObject({ statusCode: 404 });
    });

    it('patches a lane, with a default message when it is given none', async () => {
        const service = new StageConfigService(new StaticStageConfigStore(VALID));

        const lane = await service.patchLane('implementing', { settings: { maxSteps: 99 } });

        expect(lane.settings).toMatchObject({ maxSteps: 99 });
        expect((await service.laneRevisions({ lane: 'implementing' })).map(revision => revision.message)).toEqual(['Edited implementing']);
    });

    it('answers 400 with the reason for a refused patch, and 404 for no such lane', async () => {
        const service = new StageConfigService(new StaticStageConfigStore(VALID));

        await expect(service.patchLane('implementing', { onPass: 'nowhere' })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining('routes to states that do not exist') },
        });
        await expect(service.patchLane('implementing', { settings: 'nope' })).rejects.toMatchObject({ statusCode: 400 });
        await expect(service.patchLane('nope', { instructions: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('lists each stage as it would dispatch', async () => {
        const service = new StageConfigService(new StaticStageConfigStore(VALID));

        expect(await service.routing()).toEqual([
            { stage: 'implementing', mode: 'agent', adapter: 'api', provider: 'anthropic', model: 'claude-opus' },
        ]);
    });

    it('answers 404 for routing on a project with no stage config', async () => {
        const service = new StageConfigService(new StaticStageConfigStore());

        await expect(service.routing()).rejects.toMatchObject({ statusCode: 404 });
    });

    it('routes one stage and answers with the result', async () => {
        const service = new StageConfigService(new StaticStageConfigStore(VALID));

        const routed = await service.setRouting('implementing', { adapter: 'api', provider: 'openai', model: ' gpt-5 ' });

        expect(routed).toMatchObject({ provider: 'openai', model: 'gpt-5' });
        expect(await service.routing()).toEqual([routed]);
    });

    it('answers 404 for routing a stage that does not exist', async () => {
        const service = new StageConfigService(new StaticStageConfigStore(VALID));

        await expect(service.setRouting('nope', { adapter: 'api', provider: 'openai', model: 'gpt-5' })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('answers 400 for an empty model', async () => {
        const service = new StageConfigService(new StaticStageConfigStore(VALID));

        await expect(service.setRouting('implementing', { adapter: 'api', provider: 'anthropic', model: '  ' })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: 'a model is required' },
        });
    });

    it('answers 400 for a provider the cli adapter cannot run', async () => {
        const service = new StageConfigService(new StaticStageConfigStore(VALID));

        await expect(service.setRouting('implementing', { adapter: 'cli', provider: 'openai', model: 'gpt-5' })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining('always runs Claude') },
        });
    });
});
