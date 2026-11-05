import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';
import { EngineUsageRepository } from '#modules/host/engine.usage.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

// The query reads every project, and the test database is shared, so each test names accounts of its own
// and looks only at those.
const accountsOf = (rows: { account: string }[], names: string[]) => rows.filter(row => names.includes(row.account));

describe('EngineUsageRepository.byAccount', () => {
    const now = DateTime.now();
    const today = now.startOf('day');
    const window = () => new EngineUsageRepository(db).byAccount(today.minus({ days: 13 }), now.plus({ seconds: 1 }), today);

    const stageEvent = (project: string, account: string | undefined, usage: object, createdAt: DateTime, type = 'stage.passed') =>
        db
            .insertInto('wilson.cardEvents')
            .values({
                project,
                cardId: '0001',
                stage: 'implementing',
                type,
                payload: JSON.stringify({ usage, ...(account && { account }) }),
                createdAt,
            })
            .execute();

    it('sums stage, chat and planning spend by account, input including the cache', async () => {
        const project = uniqueProject();
        const account = `pool-${randomUUID()}`;
        await stageEvent(project, account, { inputTokens: 10, cachedInputTokens: 100, outputTokens: 5 }, now);
        await stageEvent(project, account, { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3 }, now, 'stage.interrupted');
        const thread = await db.insertInto('wilson.chatThreads').values({ title: 't', engine: 'cli' }).returning('id').executeTakeFirstOrThrow();
        await db
            .insertInto('wilson.chatTurnUsage')
            .values({ threadId: thread.id, engine: 'cli', model: 'm', inputTokens: 4, cachedInputTokens: 40, outputTokens: 7, account })
            .execute();
        await db
            .insertInto('wilson.planTurns')
            .values({
                project,
                cardId: '0001',
                seq: 1,
                role: 'assistant',
                content: 'hi',
                inputTokens: 2,
                cachedInputTokens: 20,
                outputTokens: 11,
                account,
            })
            .execute();

        expect(accountsOf(await window(), [account])).toEqual([
            { account, todayOutputTokens: 26, outputTokens: 26, inputTokens: 10 + 100 + 1 + 2 + 4 + 40 + 2 + 20, cachedInputTokens: 162 },
        ]);
    });

    it("counts only today's output as today's, and leaves out spend before the window", async () => {
        const project = uniqueProject();
        const account = `pool-${randomUUID()}`;
        await stageEvent(project, account, { outputTokens: 5 }, now);
        await stageEvent(project, account, { outputTokens: 50 }, today.minus({ days: 1 }));
        await stageEvent(project, account, { outputTokens: 500 }, today.minus({ days: 20 }));

        const [row] = accountsOf(await window(), [account]);

        expect(row).toMatchObject({ todayOutputTokens: 5, outputTokens: 55 });
    });

    it('leaves out spend that names no account, and events that are not a stage ending', async () => {
        const project = uniqueProject();
        const account = `pool-${randomUUID()}`;
        await stageEvent(project, undefined, { outputTokens: 5 }, now);
        await stageEvent(project, account, { outputTokens: 5 }, now, 'rule.verdicts');

        expect(accountsOf(await window(), [account])).toEqual([]);
    });

    it('orders accounts by output, most first', async () => {
        const project = uniqueProject();
        const small = `a-${randomUUID()}`;
        const large = `b-${randomUUID()}`;
        await stageEvent(project, small, { outputTokens: 1 }, now);
        await stageEvent(project, large, { outputTokens: 9 }, now);

        expect(accountsOf(await window(), [small, large]).map(row => row.account)).toEqual([large, small]);
    });
});
