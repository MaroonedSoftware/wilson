import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@maroonedsoftware/logger';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { EventLog } from '#modules/events/event.log.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { CardJobs } from '#modules/jobs/card.jobs.js';
import { RunningCards } from '#modules/jobs/running.cards.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { Card } from '#modules/board/card.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';

const card = (id: string, overrides: Partial<Card['frontmatter']> = {}, body = 'body text'): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'implementing', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body,
});

const fakeLogger = (): Logger & { warn: ReturnType<typeof vi.fn> } =>
    ({
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };

let db: Kysely<DB>;
let boardRoot: string;

beforeAll(async () => {
    db = testDb();

    const base = await mkdtemp(join(tmpdir(), 'board-write-service-'));
    boardRoot = join(base, 'board');
    await mkdir(join(boardRoot, 'config'), { recursive: true });
    await writeFile(
        join(boardRoot, 'config', 'stages.yaml'),
        [
            'stages:',
            // `onPass: testing` here, not `implementing` — `approve` reads this from config rather
            // than hard-coding a target, and picking a value other than the more obvious
            // `implementing` is what would catch a regression back to a literal.
            '  - name: backlog',
            '    mode: manual',
            '    model: claude-opus',
            '    instructions: read the plan',
            '    onPass: testing',
            '    onFail: backlog',
            '  - name: implementing',
            '    mode: agent',
            '    model: claude-opus',
            '    instructions: build it',
            '    onPass: testing',
            '    onFail: implementing',
            '  - name: testing',
            '    mode: agent',
            '    model: claude-opus',
            '    instructions: test the thing',
            '    onPass: merged',
            '    onFail: implementing',
            '',
        ].join('\n'),
        'utf8',
    );
});

afterAll(async () => {
    await db.destroy();
});

/** A `ScopeCheckResult`-shaped refusal, the exact payload a scope-check `stage.failed` event carries. */
const scopeCheckRefusal = (overrides: Partial<{ reason: string; division: unknown[] }> = {}) => ({
    summary: 'the plan repeats the same kind of work several times',
    groups: [{ title: 'endpoint', tasks: ['task 1', 'task 2'] }],
    verdict: 'refuse' as const,
    reason: 'the plan repeats "endpoint" five times',
    division: [
        { title: 'Piece A', tasks: ['task 1'], delivers: 'delivers A on its own', dependsOn: [] },
        { title: 'Piece B', tasks: ['task 2'], delivers: 'delivers B on its own', dependsOn: ['Piece A'] },
    ],
    ...overrides,
});

/**
 * A fresh project + board repository + write service for one test, isolated from every other by a
 * unique project name — the same idiom `move.command.test.ts` uses for the CLI command this service
 * ports its behaviour from, so a divergence between the two shows up as a divergence in behaviour,
 * not in how the two test files are wired up.
 */
const freshBoard = (
    worktrees: { reclaim: ReturnType<typeof vi.fn> } = { reclaim: vi.fn(async () => {}) },
    brokerOverrides: Partial<{ send: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; getJob: ReturnType<typeof vi.fn> }> = {},
    // Card 0079: `release`'s in-flight disambiguation used to shell out to `pgrep -f 'index.ts run'`;
    // now that the API is the only daemon, it asks `RunningCards` — this process's own record of
    // which cards its `CardStageJob` handler is mid-run on (see running.cards.ts). Real, not a
    // double: it's a plain in-memory set, and using the real thing exercises the actual `.add`/
    // `.snapshot` contract `release` depends on rather than a stand-in for it.
    runningCards: RunningCards = new RunningCards(),
) => {
    const events = { append: vi.fn(async () => {}) };
    const config = new StaticBoardConfig(uniqueProject(), boardRoot, '/tmp/code', '/tmp/wt', '/tmp/run');
    const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    const logger = fakeLogger();
    // `broker` is faked, but `CardJobs` is the real thing wired to the test db — `start`/`release`
    // exercise `inFlight`/`record`/`clear` for real, the same idiom `card.jobs.test.ts` uses, rather
    // than mocking the claim bookkeeping this card doesn't own.
    const broker = {
        send: vi.fn(async () => 'job-1'),
        cancel: vi.fn(async () => {}),
        getJob: vi.fn(async () => null),
        ...brokerOverrides,
    };
    const cardJobs = new CardJobs(config, db, broker as unknown as JobBroker);
    const service = new BoardWriteService(
        board,
        config,
        worktrees as unknown as WorktreeManager,
        events as unknown as EventLog,
        logger,
        cardJobs,
        broker as unknown as JobBroker,
        runningCards,
    );
    return { board, config, events, worktrees, logger, cardJobs, broker, runningCards, service };
};

/**
 * `division` reads its own `eventLog.tail(...)` directly (it is not routed through `board`'s faked
 * `events`), so `freshBoard`'s stubbed `{ append: vi.fn() }` cannot stand in for it — a fake `tail`
 * would only prove the test agrees with itself about which rows come back. This wires a real
 * `EventLog` against the same test db, so a test can `eventLog.append` a genuine `stage.failed` row
 * and `service.division` reads it back exactly as it would in production.
 */
const freshBoardWithRealEvents = () => {
    const config = new StaticBoardConfig(uniqueProject(), boardRoot, '/tmp/code', '/tmp/wt', '/tmp/run');
    const eventLog = new EventLog(db, fakeLogger());
    const board = new PostgresBoardRepository(config, db, eventLog);
    const logger = fakeLogger();
    const broker = { send: vi.fn(async () => 'job-1'), cancel: vi.fn(async () => {}), getJob: vi.fn(async () => null) };
    const cardJobs = new CardJobs(config, db, broker as unknown as JobBroker);
    const worktrees = { reclaim: vi.fn(async () => {}) };
    const runningCards = new RunningCards();
    const service = new BoardWriteService(
        board,
        config,
        worktrees as unknown as WorktreeManager,
        eventLog,
        logger,
        cardJobs,
        broker as unknown as JobBroker,
        runningCards,
    );
    return { board, config, eventLog, service };
};

describe('BoardWriteService', () => {
    describe('create', () => {
        it('assigns the next sequential id and defaults an unset stage to parking-lot, exactly like `wilson card create`', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0001', { stage: 'implementing' }), 'seed');

            const detail = await service.create({ title: 'Ship the thing', body: 'the plan' });

            expect(detail.id).toBe('0002');
            expect(detail.stage).toBe('parking-lot');
            expect(detail.title).toBe('Ship the thing');
            expect(detail.body).toBe('the plan');

            const stored = await board.read('0002');
            expect(stored.frontmatter.stage).toBe('parking-lot');
            expect(stored.frontmatter.title).toBe('Ship the thing');
            expect(stored.body).toBe('the plan');
        });

        it('creates in the requested stage when one is given, rather than always parking-lot', async () => {
            const { board, service } = freshBoard();

            const detail = await service.create({ title: 'Straight to work', stage: 'implementing', body: 'go' });

            expect(detail.stage).toBe('implementing');
            const stored = await board.read(detail.id);
            expect(stored.frontmatter.stage).toBe('implementing');
        });

        it('records the same version message the CLI records: "Create {id}: {title}"', async () => {
            const { board, service } = freshBoard();

            const detail = await service.create({ title: 'Traceable card', body: 'x' });

            const versions = await board.versions(detail.id, 10);
            expect(versions).toHaveLength(1);
            expect(versions[0].message).toBe(`Create ${detail.id}: Traceable card`);
        });

        it('starts on the next id over the highest one already on the board, not just count + 1', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0001'), 'seed');
            await board.create(card('0007'), 'seed');

            const detail = await service.create({ title: 'Next after 0007', body: 'x' });

            expect(detail.id).toBe('0008');
        });
    });

    describe('move', () => {
        it('refuses a target the stage graph does not define with a 400 carrying the same reason `wilson card move` reports', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0001', { stage: 'implementing' }), 'seed');

            await expect(service.move('0001', { stage: 'nowhere' })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('"nowhere" is not a state this board defines') },
            });

            // The refusal must not have moved the card.
            const stored = await board.read('0001');
            expect(stored.frontmatter.stage).toBe('implementing');
        });

        it('answers a card that does not exist with a 404, matching getById', async () => {
            const { service } = freshBoard();

            await expect(service.move('missing', { stage: 'testing' })).rejects.toMatchObject({ statusCode: 404 });
        });

        it('moves a card to a new stage, writing the transition event with by: human', async () => {
            const { board, events, service } = freshBoard();
            await board.create(card('0002', { stage: 'implementing' }), 'seed');

            const detail = await service.move('0002', { stage: 'testing' });

            expect(detail.stage).toBe('testing');
            const stored = await board.read('0002');
            expect(stored.frontmatter.stage).toBe('testing');
            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    cardId: '0002',
                    type: 'transition.written',
                    payload: { from: 'implementing', to: 'testing', by: 'human' },
                }),
                expect.anything(),
            );
        });

        it("clears a flagged card's needsHuman fields on an ordinary move to a different stage", async () => {
            const { board, service } = freshBoard();
            await board.create(card('0003', { stage: 'implementing', needsHuman: true, needsHumanReason: 'stuck' }), 'seed');

            const detail = await service.move('0003', { stage: 'testing' });

            expect(detail.needsHuman).toBe(false);
            expect(detail.needsHumanReason).toBeUndefined();
            const stored = await board.read('0003');
            expect(stored.frontmatter.needsHuman).toBe(false);
            expect(stored.frontmatter.needsHumanReason).toBeUndefined();
        });

        it('clears the flag even when the target is the stage the card is already in, instead of taking the no-op path', async () => {
            const { board, events, service } = freshBoard();
            await board.create(card('0004', { stage: 'implementing', needsHuman: true, needsHumanReason: 'stuck' }), 'seed');
            const versionBefore = await board.currentVersion('0004');

            const detail = await service.move('0004', { stage: 'implementing' });

            expect(detail.stage).toBe('implementing');
            expect(detail.needsHuman).toBe(false);
            // Actually wrote a new version — this did not take the bare "already in stage" no-op path.
            expect(await board.currentVersion('0004')).not.toBe(versionBefore);
            expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ type: 'transition.written' }), expect.anything());
        });

        it('stays a true no-op — no write, no event — when the card is already in the target stage and carries no flag', async () => {
            const { board, events, service } = freshBoard();
            await board.create(card('0005', { stage: 'implementing' }), 'seed');
            const versionBefore = await board.currentVersion('0005');

            const detail = await service.move('0005', { stage: 'implementing' });

            expect(detail.stage).toBe('implementing');
            expect(await board.currentVersion('0005')).toBe(versionBefore);
            expect(events.append).not.toHaveBeenCalled();
        });

        it('reclaims the worktree and records worktree.reclaimed when the move lands on a terminal stage', async () => {
            const { board, events, worktrees, service } = freshBoard();
            await board.create(card('0010', { stage: 'testing' }), 'seed');

            const detail = await service.move('0010', { stage: 'merged' });

            expect(detail.stage).toBe('merged');
            expect(worktrees.reclaim).toHaveBeenCalledTimes(1);
            expect(worktrees.reclaim).toHaveBeenCalledWith('0010');
            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({ cardId: '0010', type: 'worktree.reclaimed', payload: { cardId: '0010', target: 'merged' } }),
            );
        });

        it("never reclaims a flagged card's tree, even on a terminal move that itself clears the flag (card 0055)", async () => {
            const { board, events, worktrees, service } = freshBoard();
            await board.create(card('0011', { stage: 'testing', needsHuman: true, needsHumanReason: 'stuck' }), 'seed');

            const detail = await service.move('0011', { stage: 'merged' });

            expect(detail.stage).toBe('merged');
            expect(detail.needsHuman).toBe(false);
            expect(worktrees.reclaim).not.toHaveBeenCalled();
            expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
        });

        it('reclaims nothing when the move lands on an ordinary, non-terminal stage', async () => {
            const { board, worktrees, service } = freshBoard();
            await board.create(card('0012', { stage: 'implementing' }), 'seed');

            await service.move('0012', { stage: 'testing' });

            expect(worktrees.reclaim).not.toHaveBeenCalled();
        });

        it('still commits the transition and only logs a warning when the reclaim itself throws', async () => {
            const throwingWorktrees = {
                reclaim: vi.fn(async () => {
                    throw new Error('boom: directory busy');
                }),
            };
            const { board, events, service, logger } = freshBoard(throwingWorktrees);
            await board.create(card('0013', { stage: 'testing' }), 'seed');

            const detail = await service.move('0013', { stage: 'merged' });

            expect(detail.stage).toBe('merged');
            expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'worktree.reclaimed' }));
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('0013'));
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom: directory busy'));
        });
    });

    describe('edit', () => {
        it("edits a card's body and records the same version message the CLI records: \"Edit {id} plan body\"", async () => {
            const { board, service } = freshBoard();
            await board.create(card('0020', { stage: 'implementing' }), 'seed');

            const detail = await service.edit('0020', { body: 'new plan text' });

            expect(detail.body).toBe('new plan text');
            const stored = await board.read('0020');
            expect(stored.body).toBe('new plan text');
            const versions = await board.versions('0020', 10);
            expect(versions[0].message).toBe('Edit 0020 plan body');
        });

        it('writes nothing when the body is unchanged, unlike an ordinary edit', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0021', { stage: 'implementing' }), 'seed');
            const versionBefore = await board.currentVersion('0021');

            const detail = await service.edit('0021', { body: 'body text' });

            expect(detail.body).toBe('body text');
            expect(await board.currentVersion('0021')).toBe(versionBefore);
        });

        it('answers a card that does not exist with a 404, matching getById', async () => {
            const { service } = freshBoard();

            await expect(service.edit('missing', { body: 'x' })).rejects.toMatchObject({ statusCode: 404 });
        });
    });

    describe('depend', () => {
        it('refuses a card depending on itself with a 400, writing nothing', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0030'), 'seed');
            const versionBefore = await board.currentVersion('0030');

            await expect(service.depend('0030', { dependsOnId: '0030' })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('cannot depend on itself') },
            });
            expect(await board.currentVersion('0030')).toBe(versionBefore);
        });

        it('answers with a 404 when the target card does not exist, reading the target before the card itself', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0031'), 'seed');
            const readSpy = vi.spyOn(board, 'read');

            await expect(service.depend('0031', { dependsOnId: 'missing' })).rejects.toMatchObject({ statusCode: 404 });

            // Same order the CLI reads in: a typo in the target reads as "that card does not exist"
            // before the id being depended on is even looked at.
            const readIds = readSpy.mock.calls.map(call => call[0]);
            expect(readIds[0]).toBe('missing');
        });

        it('answers with a 404 when the depending card itself does not exist', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0032'), 'seed');

            await expect(service.depend('missing', { dependsOnId: '0032' })).rejects.toMatchObject({ statusCode: 404 });
        });

        it('records a dependency, sorted, with the same version message the CLI records', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0033'), 'seed');
            await board.create(card('0034'), 'seed');

            const detail = await service.depend('0033', { dependsOnId: '0034' });

            expect(detail.dependsOn).toEqual(['0034']);
            const stored = await board.read('0033');
            expect(stored.frontmatter.dependsOn).toEqual(['0034']);
            const versions = await board.versions('0033', 10);
            expect(versions[0].message).toBe('Add 0033 dependency on 0034');
        });

        it('is a no-op — no write — when adding a dependency already present', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0035'), 'seed');
            await board.create(card('0036', { dependsOn: ['0035'] }), 'seed');
            const versionBefore = await board.currentVersion('0036');

            const detail = await service.depend('0036', { dependsOnId: '0035' });

            expect(detail.dependsOn).toEqual(['0035']);
            expect(await board.currentVersion('0036')).toBe(versionBefore);
        });

        it('drops an existing dependency when remove is true, recording "Drop" in the version message', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0037'), 'seed');
            await board.create(card('0038', { dependsOn: ['0037'] }), 'seed');

            const detail = await service.depend('0038', { dependsOnId: '0037', remove: true });

            expect(detail.dependsOn).toEqual([]);
            const versions = await board.versions('0038', 10);
            expect(versions[0].message).toBe('Drop 0038 dependency on 0037');
        });

        it('is a no-op — no write — when removing a dependency that is not present', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0039'), 'seed');
            await board.create(card('0040'), 'seed');
            const versionBefore = await board.currentVersion('0040');

            const detail = await service.depend('0040', { dependsOnId: '0039', remove: true });

            expect(detail.dependsOn).toEqual([]);
            expect(await board.currentVersion('0040')).toBe(versionBefore);
        });
    });

    describe('ack', () => {
        it('refuses a card that is not flagged with a 400, writing nothing and appending no event', async () => {
            const { board, events, service } = freshBoard();
            await board.create(card('0041', { stage: 'implementing' }), 'seed');
            const versionBefore = await board.currentVersion('0041');

            await expect(service.ack('0041')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('not flagged for a human') },
            });
            expect(await board.currentVersion('0041')).toBe(versionBefore);
            expect(events.append).not.toHaveBeenCalled();
        });

        it('answers a card that does not exist with a 404', async () => {
            const { service } = freshBoard();

            await expect(service.ack('missing')).rejects.toMatchObject({ statusCode: 404 });
        });

        it('clears the flag and drops only the current stage retry key entirely — not zeroing it, and not touching other stages', async () => {
            const { board, events, service } = freshBoard();
            await board.create(
                card('0042', {
                    stage: 'implementing',
                    needsHuman: true,
                    needsHumanReason: 'stuck on the thing',
                    retries: { implementing: 2, testing: 1 },
                }),
                'seed',
            );

            const detail = await service.ack('0042');

            expect(detail.needsHuman).toBe(false);
            expect(detail.needsHumanReason).toBeUndefined();

            const stored = await board.read('0042');
            expect(stored.frontmatter.needsHuman).toBe(false);
            expect(stored.frontmatter.needsHumanReason).toBeUndefined();
            // The key itself is gone, not present-and-zero — the two are different shapes for "never
            // failed" and only the absent key is the one `ack` produces.
            expect(Object.prototype.hasOwnProperty.call(stored.frontmatter.retries, 'implementing')).toBe(false);
            // A different stage's retry count survives untouched.
            expect(stored.frontmatter.retries.testing).toBe(1);

            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    cardId: '0042',
                    stage: 'implementing',
                    type: 'card.acked',
                    payload: { stage: 'implementing', reason: 'stuck on the thing', retries: 2, by: 'human' },
                }),
                expect.anything(),
            );
        });
    });

    describe('approve', () => {
        const withScope = (id: string, stage: string, body = '## Goal\n\nDo it.\n\n## Files in scope\n\n- src/a.ts\n') =>
            card(id, { stage }, body);

        it('refuses a card outside backlog with a 400, writing nothing', async () => {
            const { board, service } = freshBoard();
            await board.create(withScope('0050', 'implementing'), 'seed');

            await expect(service.approve('0050')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('"implementing", not "backlog"') },
            });
            const stored = await board.read('0050');
            expect(stored.frontmatter.stage).toBe('implementing');
            expect(stored.frontmatter.planVersionId).toBeUndefined();
        });

        it('refuses a backlog card whose plan has an empty "Files in scope", writing nothing', async () => {
            const { board, service } = freshBoard();
            await board.create(withScope('0051', 'backlog', '## Goal\n\nDo it.\n\n## Files in scope\n\n'), 'seed');

            await expect(service.approve('0051')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('Files in scope') },
            });
            const stored = await board.read('0051');
            expect(stored.frontmatter.stage).toBe('backlog');
            expect(stored.frontmatter.planVersionId).toBeUndefined();
        });

        it('answers a card that does not exist with a 404', async () => {
            const { service } = freshBoard();

            await expect(service.approve('missing')).rejects.toMatchObject({ statusCode: 404 });
        });

        it("pins the version that held the plan a human just read — the one before this write, not the one this write creates — and moves to backlog's onPass target", async () => {
            const { board, events, service } = freshBoard();
            const approvedVersion = await board.create(withScope('0052', 'backlog'), 'seed');

            const detail = await service.approve('0052');

            // `stages.yaml` in this file routes backlog to "testing", not the more obvious
            // "implementing" a hard-coded target would produce.
            expect(detail.stage).toBe('testing');

            const stored = await board.read('0052');
            expect(stored.frontmatter.stage).toBe('testing');
            expect(stored.frontmatter.planVersionId).toBe(approvedVersion);

            const versionAfterApproval = await board.currentVersion('0052');
            expect(versionAfterApproval).not.toBe(approvedVersion);

            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    cardId: '0052',
                    stage: 'testing',
                    type: 'transition.written',
                    payload: { from: 'backlog', to: 'testing', by: 'human', planVersionId: approvedVersion },
                }),
                expect.anything(),
            );
        });

        it('pins the plan text as it stood at approval, so a later edit does not change what a pinned read sees', async () => {
            const { board, service } = freshBoard();
            const approvedBody = '## Goal\n\nApprove me.\n\n## Files in scope\n\n- src/a.ts\n';
            await board.create(withScope('0053', 'backlog', approvedBody), 'seed');

            await service.approve('0053');
            const pinnedVersion = (await board.read('0053')).frontmatter.planVersionId!;

            await board.write('0053', 'edit after approval', c => ({ ...c, body: '## Goal\n\nSomething else.\n\n## Files in scope\n\n- src/b.ts\n' }));

            const pinned = await board.readAt('0053', pinnedVersion);
            expect(pinned.body).toBe(approvedBody);
        });
    });

    describe('start', () => {
        it('refuses whatever whyNotDispatchable refuses, carrying its reason as a 400, and enqueues nothing', async () => {
            const { board, broker, cardJobs, service } = freshBoard();
            // "merged" is a terminal state — whyNotDispatchable refuses it before this ever reaches
            // the job queue.
            await board.create(card('0060', { stage: 'merged' }), 'seed');

            await expect(service.start('0060')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('terminal state') },
            });
            expect(broker.send).not.toHaveBeenCalled();
            expect(await cardJobs.inFlight('0060')).toBeUndefined();
        });

        it('refuses a card flagged for a human, carrying whyNotDispatchable’s reason, even though its stage is otherwise dispatchable', async () => {
            const { board, broker, service } = freshBoard();
            await board.create(card('0061', { stage: 'implementing', needsHuman: true, needsHumanReason: 'stuck' }), 'seed');

            await expect(service.start('0061')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('flagged for a human: stuck') },
            });
            expect(broker.send).not.toHaveBeenCalled();
        });

        it('refuses a card a job is already carrying, without sending a second job', async () => {
            const { board, broker, cardJobs, service } = freshBoard(
                { reclaim: vi.fn(async () => {}) },
                { getJob: vi.fn(async () => ({ id: 'job-9', name: 'card.stage', state: 'active', data: {} })) },
            );
            await board.create(card('0062', { stage: 'implementing' }), 'seed');
            await cardJobs.record('0062', 'job-9');

            await expect(service.start('0062')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('job-9 is already carrying it') },
            });
            expect(broker.send).not.toHaveBeenCalled();
        });

        it('answers a card that does not exist with a 404', async () => {
            const { service } = freshBoard();

            await expect(service.start('missing')).rejects.toMatchObject({ statusCode: 404 });
        });

        it('enqueues via broker.send and records the claim after, in that order, so the claim never precedes the job', async () => {
            const { board, broker, cardJobs, service } = freshBoard(
                { reclaim: vi.fn(async () => {}) },
                {
                    send: vi.fn(async () => 'job-77'),
                    getJob: vi.fn(async () => ({ id: 'job-77', name: 'card.stage', state: 'active', data: {} })),
                },
            );
            await board.create(card('0063', { stage: 'implementing' }), 'seed');

            const recordSpy = vi.spyOn(cardJobs, 'record');

            const detail = await service.start('0063');

            expect(detail.stage).toBe('implementing');
            expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0063', stageName: 'implementing' });
            expect(recordSpy).toHaveBeenCalledWith('0063', 'job-77');

            // `broker.send` resolves the job id `record` is called with — spying on `send`'s own
            // invocation order proves it ran first, since `record`'s argument could not exist yet
            // otherwise.
            const sendOrder = broker.send.mock.invocationCallOrder[0];
            const recordOrder = recordSpy.mock.invocationCallOrder[0];
            expect(sendOrder).toBeLessThan(recordOrder);

            expect(await cardJobs.inFlight('0063')).toBe('job-77');
        });
    });

    describe('release', () => {
        it('refuses a card holding no claim with a 400, touching neither the broker nor RunningCards', async () => {
            const { broker, runningCards, service } = freshBoard();
            const snapshotSpy = vi.spyOn(runningCards, 'snapshot');

            await expect(service.release('0070')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('holds no claim') },
            });
            expect(broker.cancel).not.toHaveBeenCalled();
            // The in-flight disambiguation only ever runs for a card that does hold a live claim.
            expect(snapshotSpy).not.toHaveBeenCalled();
        });

        // Card 0079: this is the guard itself, not just the happy path — before this card, `release`
        // asked `pgrep -f 'index.ts run'`, a pattern nothing has matched since `wilson run` was
        // deleted, so the guard failed open and cancelled every claim regardless of whether this
        // process was genuinely mid-run on it. A test that only asserted "release cancels" (below)
        // would still pass against that bug; this one exists to catch it.
        it('refuses to release while this process is running the card right now, naming the job it found', async () => {
            const runningCards = new RunningCards();
            const { board, broker, cardJobs, service } = freshBoard(
                { reclaim: vi.fn(async () => {}) },
                { getJob: vi.fn(async () => ({ id: 'job-42', name: 'card.stage', state: 'active', data: {} })) },
                runningCards,
            );
            await board.create(card('0071', { stage: 'implementing' }), 'seed');
            await cardJobs.record('0071', 'job-42');
            runningCards.add('0071');

            await expect(service.release('0071')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('job-42') },
            });
            expect(broker.cancel).not.toHaveBeenCalled();
            expect(await cardJobs.inFlight('0071')).toBe('job-42');
        });

        it('cancels the job through the broker and clears the claim, without moving the card or dispatching anything', async () => {
            const { board, broker, cardJobs, service } = freshBoard(
                { reclaim: vi.fn(async () => {}) },
                { getJob: vi.fn(async () => ({ id: 'job-55', name: 'card.stage', state: 'active', data: {} })) },
            );
            await board.create(card('0072', { stage: 'implementing' }), 'seed');
            await cardJobs.record('0072', 'job-55');
            // No `RunningCards.add` for this card: this process is not mid-run on it, so the claim is
            // one worth releasing.

            const detail = await service.release('0072');

            expect(detail.stage).toBe('implementing');
            expect(broker.cancel).toHaveBeenCalledWith('card.stage', 'job-55');
            expect(await cardJobs.inFlight('0072')).toBeUndefined();
        });

        it('cancels strictly before clearing the claim, so a crash between the two leaves the claim pointing at an already-cancelled job rather than an orphaned live one', async () => {
            const { board, broker, cardJobs, service } = freshBoard(
                { reclaim: vi.fn(async () => {}) },
                { getJob: vi.fn(async () => ({ id: 'job-88', name: 'card.stage', state: 'active', data: {} })) },
            );
            await board.create(card('0074', { stage: 'implementing' }), 'seed');
            await cardJobs.record('0074', 'job-88');
            const clearSpy = vi.spyOn(cardJobs, 'clear');

            await service.release('0074');

            const cancelOrder = broker.cancel.mock.invocationCallOrder[0];
            const clearOrder = clearSpy.mock.invocationCallOrder[0];
            expect(cancelOrder).toBeLessThan(clearOrder);
        });

        // Card 0087: a queued job — `created` or `retry` — is, by definition, one no worker has
        // picked up, so cancelling it cannot interrupt anything even while this process is otherwise
        // busy elsewhere. The response says so via `releasedAs`, rather than the one message that
        // used to cover every cancel regardless of which case it was.
        it("labels the response releasedAs: 'queued' when the broker still shows the job created — nothing has touched it yet", async () => {
            const { board, broker, cardJobs, service } = freshBoard(
                { reclaim: vi.fn(async () => {}) },
                { getJob: vi.fn(async () => ({ id: 'job-101', name: 'card.stage', state: 'created', data: {} })) },
            );
            await board.create(card('0076', { stage: 'implementing' }), 'seed');
            await cardJobs.record('0076', 'job-101');

            const detail = await service.release('0076');

            expect(detail.releasedAs).toBe('queued');
            expect(broker.cancel).toHaveBeenCalledWith('card.stage', 'job-101');
            expect(await cardJobs.inFlight('0076')).toBeUndefined();
        });

        it("labels the response releasedAs: 'queued' for a job the broker shows retrying, the other LIVE_STATES member that has not started", async () => {
            const { board, broker, cardJobs, service } = freshBoard(
                { reclaim: vi.fn(async () => {}) },
                { getJob: vi.fn(async () => ({ id: 'job-102', name: 'card.stage', state: 'retry', data: {} })) },
            );
            await board.create(card('0077', { stage: 'implementing' }), 'seed');
            await cardJobs.record('0077', 'job-102');

            const detail = await service.release('0077');

            expect(detail.releasedAs).toBe('queued');
            expect(broker.cancel).toHaveBeenCalledWith('card.stage', 'job-102');
        });

        it("labels the response releasedAs: 'orphan' when the broker still shows the job active but this process is not the one running it", async () => {
            const { board, broker, cardJobs, service } = freshBoard(
                { reclaim: vi.fn(async () => {}) },
                { getJob: vi.fn(async () => ({ id: 'job-103', name: 'card.stage', state: 'active', data: {} })) },
            );
            await board.create(card('0078', { stage: 'implementing' }), 'seed');
            await cardJobs.record('0078', 'job-103');
            // No `RunningCards.add` for this card, same as the plain-cancel test above: this process
            // is not mid-run on it, so the broker's `active` is left over from an earlier process.

            const detail = await service.release('0078');

            expect(detail.releasedAs).toBe('orphan');
            expect(broker.cancel).toHaveBeenCalledWith('card.stage', 'job-103');
        });
    });

    describe('division', () => {
        it("reads the most recent scope-check refusal's division from the event log, not a fresh run", async () => {
            const { board, config, eventLog, service } = freshBoardWithRealEvents();
            await board.create(card('0111', { stage: 'planning' }), 'seed');
            await eventLog.append({
                project: config.project,
                cardId: '0111',
                stage: 'scope-check',
                type: 'stage.failed',
                payload: { result: scopeCheckRefusal() },
            });

            const division = await service.division('0111');

            expect(division.reason).toBe('the plan repeats "endpoint" five times');
            expect(division.pieces).toEqual([
                { title: 'Piece A', tasks: ['task 1'], delivers: 'delivers A on its own', dependsOn: [] },
                { title: 'Piece B', tasks: ['task 2'], delivers: 'delivers B on its own', dependsOn: ['Piece A'] },
            ]);
        });

        it('takes the most recent refusal on record when scope-check has refused the same card more than once', async () => {
            const { board, config, eventLog, service } = freshBoardWithRealEvents();
            await board.create(card('0111', { stage: 'planning' }), 'seed');
            await eventLog.append({
                project: config.project,
                cardId: '0111',
                stage: 'scope-check',
                type: 'stage.failed',
                payload: { result: scopeCheckRefusal({ reason: 'stale refusal' }) },
            });
            await eventLog.append({
                project: config.project,
                cardId: '0111',
                stage: 'scope-check',
                type: 'stage.failed',
                payload: { result: scopeCheckRefusal({ reason: 'current refusal' }) },
            });

            const division = await service.division('0111');

            expect(division.reason).toBe('current refusal');
        });

        it('ignores stage.failed events from other stages, only ever matching scope-check', async () => {
            const { board, config, eventLog, service } = freshBoardWithRealEvents();
            await board.create(card('0111', { stage: 'planning' }), 'seed');
            await eventLog.append({
                project: config.project,
                cardId: '0111',
                stage: 'implementing',
                type: 'stage.failed',
                payload: { error: 'something else went wrong' },
            });

            await expect(service.division('0111')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('no scope-check refusal on record') },
            });
        });

        it('refuses with a 400 naming the card when there is no scope-check refusal on record at all', async () => {
            const { board, service } = freshBoardWithRealEvents();
            await board.create(card('0112', { stage: 'planning' }), 'seed');

            await expect(service.division('0112')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('0112') },
            });
        });

        it('refuses with a 400 when the most recent refusal carried no division — an empty confirmation prompt is not the fallback', async () => {
            const { board, config, eventLog, service } = freshBoardWithRealEvents();
            await board.create(card('0113', { stage: 'planning' }), 'seed');
            await eventLog.append({
                project: config.project,
                cardId: '0113',
                stage: 'scope-check',
                type: 'stage.failed',
                // A "pass" carries no division — `ScopeCheckResultSchema` defaults it to `[]`.
                payload: { result: scopeCheckRefusal({ division: [] }) },
            });

            await expect(service.division('0113')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('no division') },
            });
        });

        it('refuses with a 400 when the recorded result does not survive re-parsing as a ScopeCheckResult', async () => {
            const { board, config, eventLog, service } = freshBoardWithRealEvents();
            await board.create(card('0114', { stage: 'planning' }), 'seed');
            await eventLog.append({
                project: config.project,
                cardId: '0114',
                stage: 'scope-check',
                type: 'stage.failed',
                payload: { result: { not: 'a scope-check result' } },
            });

            await expect(service.division('0114')).rejects.toMatchObject({ statusCode: 400 });
        });

        it('answers a card that does not exist with a 404', async () => {
            const { service } = freshBoardWithRealEvents();

            await expect(service.division('missing')).rejects.toMatchObject({ statusCode: 404 });
        });
    });

    describe('split', () => {
        const twoPieces = (overrides: Partial<{ dependsOnB: string[] }> = {}) => [
            { title: 'Piece A', tasks: ['task 1'], delivers: 'delivers A on its own', dependsOn: [] },
            { title: 'Piece B', tasks: ['task 2'], delivers: 'delivers B on its own', dependsOn: overrides.dependsOnB ?? [] },
        ];

        it('creates one card per piece in planning, seeded with its tasks, delivers, and a pointer back to the origin', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0111', { stage: 'planning', title: 'Big refused card' }), 'seed');

            const result = await service.split('0111', { pieces: twoPieces() });

            expect(result.pieces).toHaveLength(2);
            const pieceA = result.pieces.find(p => p.title === 'Piece A')!;
            expect(pieceA.stage).toBe('planning');
            expect(pieceA.body).toContain('Split from 0111');
            expect(pieceA.body).toContain('Big refused card');
            expect(pieceA.body).toContain('delivers A on its own');
            expect(pieceA.body).toContain('- task 1');

            const stored = await board.read(pieceA.id);
            expect(stored.frontmatter.stage).toBe('planning');
            expect(stored.frontmatter.title).toBe('Piece A');
        });

        it('records the dependency named in dependsOn between the created cards, resolving titles to the new ids', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0111', { stage: 'planning' }), 'seed');

            const result = await service.split('0111', { pieces: twoPieces({ dependsOnB: ['Piece A'] }) });

            const pieceA = result.pieces.find(p => p.title === 'Piece A')!;
            const pieceB = result.pieces.find(p => p.title === 'Piece B')!;
            const storedB = await board.read(pieceB.id);
            expect(storedB.frontmatter.dependsOn).toEqual([pieceA.id]);
        });

        it('creates no dependency for a piece whose dependsOn is empty', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0111', { stage: 'planning' }), 'seed');

            const result = await service.split('0111', { pieces: twoPieces() });

            const pieceA = result.pieces.find(p => p.title === 'Piece A')!;
            const stored = await board.read(pieceA.id);
            expect(stored.frontmatter.dependsOn).toEqual([]);
        });

        it('returns the origin and pieces in the same order the request sent them, not creation order or alphabetical', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0111', { stage: 'planning' }), 'seed');

            const result = await service.split('0111', {
                pieces: [
                    { title: 'Zed piece', tasks: ['z'], delivers: 'z', dependsOn: [] },
                    { title: 'Alpha piece', tasks: ['a'], delivers: 'a', dependsOn: [] },
                ],
            });

            expect(result.pieces.map(p => p.title)).toEqual(['Zed piece', 'Alpha piece']);
        });

        it('annotates the origin card with the ids it was split into, without moving it or dropping it', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0111', { stage: 'planning' }), 'seed');

            const result = await service.split('0111', { pieces: twoPieces() });

            expect(result.origin.id).toBe('0111');
            expect(result.origin.stage).toBe('planning');
            expect(result.origin.body).toContain(`Split into: ${result.pieces.map(p => p.id).join(', ')}`);

            const stored = await board.read('0111');
            expect(stored.frontmatter.stage).toBe('planning');
        });

        it('refuses fewer than two pieces with a 400, creating nothing', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0112', { stage: 'planning' }), 'seed');

            await expect(
                service.split('0112', { pieces: [{ title: 'Only piece', tasks: ['task 1'], delivers: 'delivers it all', dependsOn: [] }] }),
            ).rejects.toMatchObject({ statusCode: 400, details: { reason: expect.stringContaining('at least two pieces') } });

            expect(await board.list()).toHaveLength(1);
        });

        it('refuses duplicate piece titles with a 400, creating nothing', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0113', { stage: 'planning' }), 'seed');

            await expect(
                service.split('0113', {
                    pieces: [
                        { title: 'Same title', tasks: ['task 1'], delivers: 'd1', dependsOn: [] },
                        { title: 'Same title', tasks: ['task 2'], delivers: 'd2', dependsOn: [] },
                    ],
                }),
            ).rejects.toMatchObject({ statusCode: 400, details: { reason: expect.stringContaining('unique') } });

            expect(await board.list()).toHaveLength(1);
        });

        it('refuses a piece that lists itself as a dependency with a 400, creating nothing', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0114', { stage: 'planning' }), 'seed');

            await expect(
                service.split('0114', {
                    pieces: [
                        { title: 'Piece A', tasks: ['task 1'], delivers: 'd1', dependsOn: ['Piece A'] },
                        { title: 'Piece B', tasks: ['task 2'], delivers: 'd2', dependsOn: [] },
                    ],
                }),
            ).rejects.toMatchObject({ statusCode: 400, details: { reason: expect.stringContaining('itself') } });

            expect(await board.list()).toHaveLength(1);
        });

        it('refuses a piece depending on a title that is not among the pieces being created, with a 400, creating nothing', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0115', { stage: 'planning' }), 'seed');

            await expect(
                service.split('0115', {
                    pieces: [
                        { title: 'Piece A', tasks: ['task 1'], delivers: 'd1', dependsOn: ['Not a real piece'] },
                        { title: 'Piece B', tasks: ['task 2'], delivers: 'd2', dependsOn: [] },
                    ],
                }),
            ).rejects.toMatchObject({ statusCode: 400, details: { reason: expect.stringContaining('Not a real piece') } });

            expect(await board.list()).toHaveLength(1);
        });

        it('answers an origin card that does not exist with a 404', async () => {
            const { service } = freshBoard();

            await expect(service.split('missing', { pieces: twoPieces() })).rejects.toMatchObject({ statusCode: 404 });
        });
    });
});
