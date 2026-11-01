import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { AUTO_SPLIT_MAX_DEPTH, AutoSplitter } from '#modules/board/auto.splitter.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { unsatisfiedDependencies } from '#modules/board/next.card.js';
import type { Card } from '#modules/board/card.js';
import type { DB } from '#modules/data/db.js';
import { EventLog } from '#modules/events/event.log.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import type { SupportedRefusal } from '#modules/stages/stage.result.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const card = (id: string, overrides: Partial<Card['frontmatter']> = {}): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'scope-check', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body: '## Goal\n\nDo a lot.',
});

const refusal = (overrides: Partial<SupportedRefusal> = {}): SupportedRefusal => ({
    reason: 'eight endpoints',
    division: [
        { title: 'First half', tasks: ['task 1'], delivers: 'half of it', dependsOn: ['Second half'] },
        { title: 'Second half', tasks: ['task 2'], delivers: 'the rest', dependsOn: [] },
    ],
    ...overrides,
});

describe('AutoSplitter', () => {
    let board: PostgresBoardRepository;
    let events: EventLog;
    let project: string;

    const splitter = (enabled = true) =>
        new AutoSplitter(
            board,
            new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run'),
            { get: vi.fn(async () => enabled) } as unknown as SettingsStore,
            events,
            logger as never,
        );
    const eventsOf = async (id: string) =>
        (await events.tail(project, id, 50)).map(row => ({ type: row.type, payload: row.payload as Record<string, unknown> }));

    beforeEach(() => {
        project = uniqueProject();
        events = new EventLog(db, logger as never);
        board = new PostgresBoardRepository(new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run'), db, events);
    });

    it('does nothing at all when the setting is off', async () => {
        await board.create(card('0001'), 'seed');

        await expect(splitter(false).split('0001', 'scope-check', refusal())).resolves.toBeUndefined();

        expect(await board.list()).toHaveLength(1);
        expect(await eventsOf('0001')).toEqual([]);
    });

    it('creates the pieces in planning, wired to each other, and retires the origin to split', async () => {
        await board.create(card('0001', { retries: { 'scope-check': 1 } }), 'seed');

        await expect(splitter().split('0001', 'scope-check', refusal())).resolves.toEqual({ pieceIds: ['0002', '0003'] });

        const first = await board.read('0002');
        expect(first.frontmatter).toMatchObject({ stage: 'planning', splitFrom: '0001', dependsOn: ['0003'] });
        expect(first.body).toContain('half of it');

        const origin = await board.read('0001');
        expect(origin.frontmatter.stage).toBe('split');
        expect(origin.frontmatter.retries).toEqual({ 'scope-check': 1 });
        expect(origin.body).toContain('Split automatically into: 0002, 0003');
    });

    it('records in the versions and the event log that the split was automatic', async () => {
        await board.create(card('0001'), 'seed');

        await splitter().split('0001', 'scope-check', refusal());

        expect((await board.versions('0001', 1))[0]?.message).toBe('Auto-split 0001 into 0002, 0003');
        expect((await board.versions('0002', 1))[0]?.message).toBe('Auto-split 0001 into 0002: First half');

        const recorded = await eventsOf('0001');
        expect(recorded.find(e => e.type === 'transition.written')?.payload).toMatchObject({
            from: 'scope-check',
            to: 'split',
            by: 'runner',
            autoSplit: true,
        });
        expect(recorded.find(e => e.type === 'card.auto-split')?.payload).toEqual({
            pieces: [
                { id: '0002', title: 'First half' },
                { id: '0003', title: 'Second half' },
            ],
            reason: 'eight endpoints',
        });
    });

    it('creates nothing the second time: a repeated run finds the origin already split', async () => {
        await board.create(card('0001'), 'seed');

        await splitter().split('0001', 'scope-check', refusal());
        await expect(splitter().split('0001', 'scope-check', refusal())).resolves.toEqual({ pieceIds: [] });

        expect(await board.list()).toHaveLength(3);
    });

    it('creates one set of pieces when two runs race', async () => {
        await board.create(card('0001'), 'seed');

        const results = await Promise.all([splitter().split('0001', 'scope-check', refusal()), splitter().split('0001', 'scope-check', refusal())]);

        expect(results.map(result => result?.pieceIds.length).sort()).toEqual([0, 2]);
        expect(await board.list()).toHaveLength(3);
    });

    it('does not strand a dependent: it waits on the pieces and clears when they merge', async () => {
        await board.create(card('0001'), 'seed');
        await board.create(card('0002', { stage: 'backlog', dependsOn: ['0001'] }), 'seed');

        await splitter().split('0001', 'scope-check', refusal());

        const waiting = await board.list();
        const dependent = waiting.find(c => c.frontmatter.id === '0002')!;
        expect(unsatisfiedDependencies(dependent, waiting)).toEqual(['0001']);

        const merged = waiting.map(c => (c.frontmatter.splitFrom === '0001' ? { ...c, frontmatter: { ...c.frontmatter, stage: 'merged' } } : c));
        expect(unsatisfiedDependencies(dependent, merged)).toEqual([]);
    });

    describe('falls back to the ordinary kickback, saying why', () => {
        const expectSkipped = async (result: unknown, reason: string | RegExp, cards: number) => {
            expect(result).toBeUndefined();
            expect(await board.list()).toHaveLength(cards);
            expect((await board.read('0001')).frontmatter.stage).not.toBe('split');
            const skipped = (await eventsOf('0001')).find(e => e.type === 'card.auto-split-skipped');
            expect(skipped?.payload.reason).toMatch(reason);
        };

        it('on a division split would refuse', async () => {
            await board.create(card('0001'), 'seed');
            const division = refusal().division.map(piece => ({ ...piece, title: 'Same', dependsOn: [] }));

            await expectSkipped(await splitter().split('0001', 'scope-check', refusal({ division })), 'piece titles must be unique', 1);
        });

        it('on pieces that wait on each other', async () => {
            await board.create(card('0001'), 'seed');
            const [a, b] = refusal().division;

            await expectSkipped(
                await splitter().split('0001', 'scope-check', refusal({ division: [a!, { ...b!, dependsOn: [a!.title] }] })),
                /wait on each other/,
                1,
            );
        });

        it('at the depth cap', async () => {
            await board.create(card('0001', { stage: 'split' }), 'seed');
            await board.create(card('0002', { stage: 'split', splitFrom: '0001' }), 'seed');
            await board.create(card('0003', { splitFrom: '0002' }), 'seed');

            const result = await splitter().split('0003', 'scope-check', refusal());

            expect(result).toBeUndefined();
            expect(await board.list()).toHaveLength(3);
            const skipped = (await eventsOf('0003')).find(e => e.type === 'card.auto-split-skipped');
            expect(skipped?.payload.reason).toContain(`auto-split cap of ${AUTO_SPLIT_MAX_DEPTH}`);
        });

        it('one level above the cap, a piece still splits', async () => {
            await board.create(card('0001', { stage: 'split' }), 'seed');
            await board.create(card('0002', { splitFrom: '0001' }), 'seed');

            await expect(splitter().split('0002', 'scope-check', refusal())).resolves.toEqual({ pieceIds: ['0003', '0004'] });
        });

        it('when a manual split already gave the origin pieces', async () => {
            await board.create(card('0001'), 'seed');
            await board.create(card('0002', { stage: 'planning', splitFrom: '0001' }), 'seed');

            await expectSkipped(await splitter().split('0001', 'scope-check', refusal()), /already has pieces/, 2);
        });

        it('when the card moved while the stage ran', async () => {
            await board.create(card('0001', { stage: 'parking-lot' }), 'seed');

            await expectSkipped(await splitter().split('0001', 'scope-check', refusal()), /moved to "parking-lot"/, 1);
        });

        it('when the transaction fails, having written nothing', async () => {
            await board.create(card('0001'), 'seed');
            vi.spyOn(board, 'applySplit').mockRejectedValueOnce(new Error('id taken'));

            await expectSkipped(await splitter().split('0001', 'scope-check', refusal()), /id taken/, 1);
        });
    });
});
