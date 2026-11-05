import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import type { DB } from '#modules/data/db.js';
import { EvalBatchesService } from '#modules/evals/eval.batches.service.js';
import { EvalFixtureRepository } from '#modules/evals/eval.fixture.repository.js';
import { EvalRunRepository } from '#modules/evals/eval.run.repository.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const lanes = `
stages:
  - name: review
    mode: agent
    adapter: api
    provider: anthropic
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: review
  - name: testing
    mode: agent
    adapter: api
    provider: anthropic
    model: claude-opus
    instructions: test it
    onPass: review
    onFail: testing
`;

const plan: Card = { frontmatter: { id: '0001', title: 't', stage: 'review', dependsOn: [], retries: {} }, sections: {}, body: 'b' };

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

describe('EvalBatchesService', () => {
    let service: EvalBatchesService;
    let store: StaticStageConfigStore;
    let runs: EvalRunRepository;
    let review: string;
    let testing: string;
    const send = vi.fn(async () => 'job');

    beforeEach(async () => {
        send.mockClear();
        const config = new StaticBoardConfig(uniqueProject(), '/code', '/wt', '/run');
        const fixtures = new EvalFixtureRepository(config, db);
        const insert = async (stage: string, event: string) =>
            (await fixtures.insert({ sourceCardId: '0001', stage, sourceEventId: event, planVersionId: '1', plan, baseSha: 'a', headSha: 'b' }))!.id;
        review = await insert('review', '1');
        testing = await insert('testing', '2');
        runs = new EvalRunRepository(config, db);
        store = new StaticStageConfigStore(lanes);
        service = new EvalBatchesService(
            config,
            runs,
            fixtures,
            { find: async (name: string) => (name === 'my-mac' ? { name } : undefined) } as never,
            store,
            { load: async () => 'the learnings' } as never,
            { send } as never,
        );
    });

    it('starts a batch of the current lanes, freezing them and the learnings, and sends its first job', async () => {
        const { batch, runs: created } = await service.create({ fixtureIds: [review], host: 'my-mac', runs: 2 });

        expect(created.map(run => run.arm)).toEqual(['current', 'current']);
        expect(batch).toMatchObject({ status: 'running', host: 'my-mac', maxOutputTokens: 300_000 });
        expect(batch).not.toHaveProperty('candidate');
        const row = await runs.batch(batch.id);
        expect(row?.learnings).toBe('the learnings');
        expect(row?.candidateLanes).toBeUndefined();
        expect(send).toHaveBeenCalledOnce();
    });

    it('alternates arms with a candidate, and freezes both configs without saving anything', async () => {
        const before = await store.lanes();

        const { batch, runs: created } = await service.create({
            fixtureIds: [review],
            host: 'my-mac',
            runs: 2,
            candidate: { lane: 'review', instructions: 'review it harder' },
        });

        expect(created.map(run => run.arm)).toEqual(['current', 'candidate', 'current', 'candidate']);
        expect(batch.candidate).toEqual({ lane: 'review', instructions: 'review it harder' });
        const row = await runs.batch(batch.id);
        expect(JSON.stringify(row?.currentLanes)).toContain('review it"');
        expect(JSON.stringify(row?.candidateLanes)).toContain('review it harder');
        expect(await store.lanes()).toEqual(before);
    });

    it('accepts a candidate that changes nothing, for an A/A batch', async () => {
        const { batch } = await service.create({ fixtureIds: [review], host: 'my-mac', candidate: { lane: 'review' } });
        const row = await runs.batch(batch.id);

        expect(row?.candidateLanes).toEqual(row?.currentLanes);
    });

    it('refuses a candidate on a lane a fixture never read', async () => {
        await expect(service.create({ fixtureIds: [testing], host: 'my-mac', candidate: { lane: 'review' } })).rejects.toMatchObject({
            statusCode: 400,
        });
        expect(send).not.toHaveBeenCalled();
    });

    it('refuses a candidate that would not validate, as a 400', async () => {
        await expect(
            service.create({ fixtureIds: [review], host: 'my-mac', candidate: { lane: 'review', settings: { maxSteps: -1 } } }),
        ).rejects.toMatchObject({
            statusCode: 400,
        });
    });

    it('refuses settings that are not a mapping', async () => {
        await expect(service.create({ fixtureIds: [review], host: 'my-mac', candidate: { lane: 'review', settings: ['x'] } })).rejects.toMatchObject({
            statusCode: 400,
        });
    });

    it('refuses an unknown fixture or host, and no fixtures at all', async () => {
        await expect(service.create({ fixtureIds: ['999999'], host: 'my-mac' })).rejects.toMatchObject({ statusCode: 404 });
        await expect(service.create({ fixtureIds: [review], host: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
        await expect(service.create({ fixtureIds: [], host: 'my-mac' })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('refuses a run count out of range', async () => {
        await expect(service.create({ fixtureIds: [review], host: 'my-mac', runs: 0 })).rejects.toMatchObject({ statusCode: 400 });
        await expect(service.create({ fixtureIds: [review], host: 'my-mac', runs: 21 })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('stops a batch, and answers 404 for one it does not have', async () => {
        const { batch } = await service.create({ fixtureIds: [review], host: 'my-mac', runs: 1 });

        const stopped = await service.stop(batch.id);

        expect(stopped.batch.status).toBe('stopped');
        expect(stopped.runs[0]!.status).toBe('skipped');
        await expect(service.stop('999999')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('reports totals per arm', async () => {
        const { batch } = await service.create({ fixtureIds: [review], host: 'my-mac', runs: 1, candidate: { lane: 'review' } });

        const shown = await service.show(batch.id);

        expect(shown.totals.map(total => total.arm)).toEqual(['current', 'candidate']);
    });
});
