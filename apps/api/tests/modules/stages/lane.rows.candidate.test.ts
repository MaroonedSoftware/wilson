import { describe, expect, it } from 'vitest';
import { applyCandidate, documentFromLanes } from '#modules/stages/lane.rows.js';
import { StageConfigError, validateStages } from '#modules/stages/stage.config.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';

const yaml = `
stages:
  - name: implementing
    mode: agent
    adapter: api
    provider: anthropic
    model: claude-opus
    instructions: implement it
    maxSteps: 40
    onPass: review
    onFail: implementing
  - name: review
    mode: agent
    adapter: api
    provider: anthropic
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: implementing
`;

const config = () => new StaticStageConfigStore(yaml).laneConfig();

describe('applyCandidate', () => {
    it('changes the instructions of the one lane it names', async () => {
        const next = applyCandidate(await config(), { lane: 'review', instructions: 'review it harder' }, 'test');

        const { stages } = validateStages(documentFromLanes(next), 'test');
        expect(stages.find(stage => stage.name === 'review')?.instructions).toBe('review it harder');
        expect(stages.find(stage => stage.name === 'implementing')?.instructions).toBe('implement it');
    });

    it('changes a lane route and settings, keeping settings it does not name', async () => {
        const next = applyCandidate(await config(), { lane: 'implementing', model: 'claude-sonnet', settings: { maxSteps: 80 } }, 'test');

        const stage = validateStages(documentFromLanes(next), 'test').stages.find(({ name }) => name === 'implementing');
        expect(stage?.model).toBe('claude-sonnet');
        expect(stage?.maxSteps).toBe(80);
        expect(stage?.provider).toBe('anthropic');
    });

    it('leaves the config it was given alone, so nothing is saved', async () => {
        const store = new StaticStageConfigStore(yaml);
        const before = await store.laneConfig();

        applyCandidate(before, { lane: 'review', instructions: 'changed', model: 'claude-sonnet' }, 'test');

        expect((await store.lanes()).find(lane => lane.name === 'review')?.instructions).toBe('review it');
        expect(before.lanes.find(lane => lane.name === 'review')?.model).toBe('claude-opus');
    });

    it('refuses a lane that does not exist', async () => {
        const base = await config();
        expect(() => applyCandidate(base, { lane: 'nope', instructions: 'x' }, 'test')).toThrow(StageConfigError);
    });

    it('refuses a candidate that would not validate', async () => {
        const base = await config();
        expect(() => applyCandidate(base, { lane: 'review', settings: { maxSteps: -1 } }, 'test')).toThrow(StageConfigError);
    });

    it('refuses a setting that has its own field', async () => {
        const base = await config();
        expect(() => applyCandidate(base, { lane: 'review', settings: { model: 'other' } }, 'test')).toThrow(/cannot be set as settings/);
    });
});
