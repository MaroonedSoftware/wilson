import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { POSITION_GAP } from '#modules/board/card.position.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { unsatisfiedDependencies } from '#modules/board/next.card.js';
import { DRY_RUN_INTEGRATION_BRANCH } from '#modules/worktree/worktree.manager.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import { RE_REVIEW_ON_MERGE } from '#modules/settings/re.review.on.merge.setting.js';
import { DAILY_OUTPUT_TOKEN_CEILING } from '#modules/settings/daily.output.token.ceiling.setting.js';
import type { Card } from '#modules/board/card.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';
import { DateTime } from 'luxon';

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

const exec = promisify(execFile);

let db: Kysely<DB>;

/**
 * The stage config every `freshBoard` below reads. Stage config is a `StageConfigStore` now rather
 * than `config/stages.yaml` under a board directory, so this is one in-memory store shared across the
 * file.
 */
const stageConfigs = new StaticStageConfigStore(
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
);

beforeAll(async () => {
    db = testDb();
});

afterAll(async () => {
    await db.destroy();
});

/** A `ScopeCheckResult`-shaped refusal, the exact payload a scope-check `stage.failed` event carries. */
const scopeCheckRefusal = (overrides: Partial<{ reason: string; division: unknown[] }> = {}) => ({
    summary: 'the plan repeats the same kind of work several times',
    groups: [{ title: 'endpoint', tasks: ['task 1', 'task 2'], sites: 2 }],
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
/**
 * Card 0264: `start` now reads `DAILY_OUTPUT_TOKEN_CEILING` through `SettingsStore` unconditionally,
 * before anything else it does — every `freshBoard()` caller used to hand it
 * `undefined as unknown as SettingsStore`, which `service.start` could survive only because nothing
 * before this card ever called `.get()` on it. This resolves any definition to its own coded default
 * (0 for the ceiling, meaning "no ceiling", exactly like a fresh, untouched database) so every test
 * that predates this card keeps exercising precisely the behaviour it always did; the ceiling tests
 * in the `start` describe block below build their own settings fake with a real ceiling instead.
 */
const defaultSettings = (): SettingsStore =>
    ({
        get: vi.fn(async (definition: { defaultValue: unknown }) => definition.defaultValue),
        set: vi.fn(async () => undefined),
    }) as unknown as SettingsStore;

const freshBoard = (
    worktrees: {
        reclaim: ReturnType<typeof vi.fn>;
        branchName?: ReturnType<typeof vi.fn>;
        hasWork?: ReturnType<typeof vi.fn>;
    } = {
        reclaim: vi.fn(async () => {}),
        // `rename` (card 0094) always calls these two; a card with no history has no work on any
        // branch, so a default that answers `false` lets every test that isn't about `rename`'s own
        // guard ignore it entirely — only the guard's own tests below pass a worktrees double that
        // says otherwise.
        branchName: vi.fn((cardId: string, title: string) => `card/${cardId}-${title}`),
        hasWork: vi.fn(async () => false),
    },
    brokerOverrides: Partial<{ send: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; getJob: ReturnType<typeof vi.fn> }> = {},
    // Card 0079: `release`'s in-flight disambiguation used to shell out to `pgrep -f 'index.ts run'`;
    // now that the API is the only daemon, it asks `RunningCards` — this process's own record of
    // which cards its `CardStageJob` handler is mid-run on (see running.cards.ts). Real, not a
    // double: it's a plain in-memory set, and using the real thing exercises the actual `.add`/
    // `.snapshot` contract `release` depends on rather than a stand-in for it.
    runningCards: RunningCards = new RunningCards(),
    // Card 0264: a per-test override so the ceiling tests below can hand `start` a `SettingsStore`
    // that answers a real ceiling for `DAILY_OUTPUT_TOKEN_CEILING`, without disturbing every other
    // caller of `freshBoard` above, which gets `defaultSettings()` and so never sees a ceiling at all.
    settings: SettingsStore = defaultSettings(),
) => {
    // `outputTokensSince` is card 0264's own addition to `EventLog` — present here (answering zero)
    // so any test can override it, but never exercised unless a test's own `settings` reports a
    // ceiling above zero, since `start` skips the read entirely at the coded default.
    const events = { append: vi.fn(async () => {}), outputTokensSince: vi.fn(async () => 0) };
    const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
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
        settings,
        stageConfigs,
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
    const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
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
        undefined as unknown as SettingsStore,
        stageConfigs,
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

    describe('createFromSource', () => {
        it('creates the card in parking-lot with the external ref recorded, regardless of the id passed', async () => {
            const { board, service } = freshBoard();

            const created = await service.createFromSource('linear', 'ENG-123', 'Fix the thing', 'It is broken.');

            expect(created.frontmatter.stage).toBe('parking-lot');
            expect(created.frontmatter.title).toBe('Fix the thing');
            expect(created.body).toBe('It is broken.');
            expect(created.frontmatter.external).toEqual({ linear: 'ENG-123' });

            const stored = await board.read(created.frontmatter.id);
            expect(stored.frontmatter.external).toEqual({ linear: 'ENG-123' });
            expect(stored.frontmatter.stage).toBe('parking-lot');
        });

        it('assigns the next sequential id, the same as `create`', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0001', { stage: 'implementing' }), 'seed');

            const created = await service.createFromSource('linear', 'ENG-1', 'Title', 'Body');

            expect(created.frontmatter.id).toBe('0002');
        });

        it('records a version message naming the source and external id', async () => {
            const { board, service } = freshBoard();

            const created = await service.createFromSource('linear', 'ENG-9', 'Traceable', 'x');

            const versions = await board.versions(created.frontmatter.id, 10);
            expect(versions).toHaveLength(1);
            expect(versions[0].message).toBe(`Create ${created.frontmatter.id} from linear ENG-9: Traceable`);
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

        // Card 0178: `stageEnteredAt` is populated only in the read path `BoardService.list`/
        // `getById` serve — a write response built through this service's shared `toCardDetail`
        // leaves it absent even right after writing the very transition that would answer it,
        // rather than this service re-deriving the same fact a second way.
        it('leaves stageEnteredAt absent on the response to a move, even though it just wrote the transition that would answer it', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0002', { stage: 'implementing' }), 'seed');

            const detail = await service.move('0002', { stage: 'testing' });

            expect(detail.stageEnteredAt).toBeUndefined();
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

        describe('entering backlog — card 0127: this is the approval gate now, whatever the source', () => {
            const withScope = (id: string, stage: string, body = '## Goal\n\nDo it.\n\n## Files in scope\n\n- src/a.ts\n') =>
                card(id, { stage }, body);

            it('pins the plan version on entering backlog from planning', async () => {
                const { board, events, service } = freshBoard();
                const planVersion = await board.create(withScope('0090', 'planning'), 'seed');

                const detail = await service.move('0090', { stage: 'backlog' });

                expect(detail.stage).toBe('backlog');
                const stored = await board.read('0090');
                expect(stored.frontmatter.planVersionId).toBe(planVersion);
                expect(events.append).toHaveBeenCalledWith(
                    expect.objectContaining({
                        cardId: '0090',
                        stage: 'backlog',
                        type: 'transition.written',
                        payload: { from: 'planning', to: 'backlog', by: 'human', planVersionId: planVersion },
                    }),
                    expect.anything(),
                );
            });

            it('pins the plan version on entering backlog from parking-lot too — most of this board\'s cards arrive this way', async () => {
                const { board, service } = freshBoard();
                const planVersion = await board.create(withScope('0091', 'parking-lot'), 'seed');

                const detail = await service.move('0091', { stage: 'backlog' });

                expect(detail.stage).toBe('backlog');
                const stored = await board.read('0091');
                expect(stored.frontmatter.planVersionId).toBe(planVersion);
            });

            it('refuses entering backlog with an empty "Files in scope", writing nothing — the same refusal `approve` always made', async () => {
                const { board, service } = freshBoard();
                await board.create(withScope('0092', 'planning', '## Goal\n\nDo it.\n\n## Files in scope\n\n'), 'seed');

                await expect(service.move('0092', { stage: 'backlog' })).rejects.toMatchObject({
                    statusCode: 400,
                    details: { reason: expect.stringContaining('Files in scope') },
                });
                const stored = await board.read('0092');
                expect(stored.frontmatter.stage).toBe('planning');
                expect(stored.frontmatter.planVersionId).toBeUndefined();
            });

            it('pins the version that held the plan text at the moment of entry, not the version this write itself creates (the deliberate off-by-one)', async () => {
                const { board, service } = freshBoard();
                const approvedBody = '## Goal\n\nApprove me.\n\n## Files in scope\n\n- src/a.ts\n';
                await board.create(withScope('0093', 'planning', approvedBody), 'seed');

                await service.move('0093', { stage: 'backlog' });
                const pinnedVersion = (await board.read('0093')).frontmatter.planVersionId!;

                await board.write('0093', 'edit after entering backlog', c => ({
                    ...c,
                    body: '## Goal\n\nSomething else.\n\n## Files in scope\n\n- src/b.ts\n',
                }));

                const pinned = await board.readAt('0093', pinnedVersion);
                expect(pinned.body).toBe(approvedBody);
            });

            it('does not re-pin a card already in backlog when it is only re-moved to backlog to clear a flag', async () => {
                const { board, service } = freshBoard();
                await board.create(withScope('0094', 'planning'), 'seed');
                await service.move('0094', { stage: 'backlog' });
                const pinnedVersion = (await board.read('0094')).frontmatter.planVersionId!;
                await board.write('0094', 'flag it', c => ({
                    ...c,
                    frontmatter: { ...c.frontmatter, needsHuman: true, needsHumanReason: 'stuck' },
                }));

                const detail = await service.move('0094', { stage: 'backlog' });

                expect(detail.stage).toBe('backlog');
                expect(detail.needsHuman).toBe(false);
                const stored = await board.read('0094');
                expect(stored.frontmatter.planVersionId).toBe(pinnedVersion);
            });
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

    describe('reposition', () => {
        it('answers a card that does not exist with a 404', async () => {
            const { service } = freshBoard();

            await expect(service.reposition('missing', {})).rejects.toMatchObject({ statusCode: 404 });
        });

        it('refuses a card outside parking-lot with a 400 naming its actual stage, writing nothing', async () => {
            const { board, events, service } = freshBoard();
            await board.create(card('0080', { stage: 'implementing' }), 'seed');
            const versionBefore = await board.currentVersion('0080');

            await expect(service.reposition('0080', {})).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('it is in "implementing", not "parking-lot"') },
            });
            expect(await board.currentVersion('0080')).toBe(versionBefore);
            expect(events.append).not.toHaveBeenCalled();
        });

        it('refuses when beforeId names a card that does not exist, with a 404', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');

            await expect(service.reposition('0080', { beforeId: 'missing' })).rejects.toMatchObject({ statusCode: 404 });
        });

        it('refuses when the named neighbour is not itself in parking-lot, with a 400', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0081', { stage: 'implementing' }), 'seed');

            await expect(service.reposition('0080', { afterId: '0081' })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('"0081" is not a card in "parking-lot"') },
            });
        });

        it('refuses a card named as its own neighbour, with a 400', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');

            await expect(service.reposition('0080', { beforeId: '0080' })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('cannot be its own neighbour') },
            });
        });

        it('positions the only card in an empty column a full gap above zero, persisting through the repository', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');

            const detail = await service.reposition('0080', {});

            expect(detail.position).toBe(POSITION_GAP);
            const stored = await board.read('0080');
            expect(stored.frontmatter.position).toBe(POSITION_GAP);
        });

        it('ranks a card at the integer midpoint of two already-positioned neighbours', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0081', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0089', { stage: 'parking-lot' }), 'seed');
            // `create` never persists `position` (it is set only through `setPosition`), so give the
            // neighbours real values the way an earlier drag actually would.
            await board.setPosition('0080', 1000);
            await board.setPosition('0081', 2000);

            const detail = await service.reposition('0089', { beforeId: '0080', afterId: '0081' });

            expect(detail.position).toBe(1500);
        });

        it('writes no card version and appends no event — ordering is not runner state', async () => {
            const { board, events, service } = freshBoard();
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');
            const versionBefore = await board.currentVersion('0080');

            await service.reposition('0080', {});

            expect(await board.currentVersion('0080')).toBe(versionBefore);
            expect(events.append).not.toHaveBeenCalled();
        });

        it('renormalises the column when the neighbours are adjacent integers with no room between them, then ranks against the fresh values', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0081', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0082', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0089', { stage: 'parking-lot' }), 'seed');
            await board.setPosition('0080', 1000);
            await board.setPosition('0081', 1001);

            const detail = await service.reposition('0089', { beforeId: '0080', afterId: '0081' });

            // The whole column was renormalised in its existing `position, id` order — 0080, 0081,
            // then 0082 (unpositioned, so it sorted last) — before ranking against the fresh values.
            expect((await board.read('0080')).frontmatter.position).toBe(POSITION_GAP);
            expect((await board.read('0081')).frontmatter.position).toBe(POSITION_GAP * 2);
            expect((await board.read('0082')).frontmatter.position).toBe(POSITION_GAP * 3);
            expect(detail.position).toBe(Math.floor((POSITION_GAP + POSITION_GAP * 2) / 2));
        });

        it('renormalises when a named neighbour exists but has never itself been positioned, since there is nothing to rank against', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0089', { stage: 'parking-lot' }), 'seed');

            const detail = await service.reposition('0089', { beforeId: '0080' });

            expect((await board.read('0080')).frontmatter.position).toBe(POSITION_GAP);
            // Landing after the sole (now-positioned) neighbour, with nothing below it.
            expect(detail.position).toBe(POSITION_GAP * 2);
        });

        it('does not disturb a card outside the parking lot when renormalising the column', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0081', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0089', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0099', { stage: 'implementing' }), 'seed');
            await board.setPosition('0080', 1000);
            await board.setPosition('0081', 1001);
            await board.setPosition('0099', 500);

            await service.reposition('0089', { beforeId: '0080', afterId: '0081' });

            expect((await board.read('0099')).frontmatter.position).toBe(500);
        });

        it('refuses omitting both beforeId and afterId when the column holds other cards, rather than silently ranking as if it were empty', async () => {
            const { board, events, service } = freshBoard();
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0081', { stage: 'parking-lot' }), 'seed');
            const versionBefore = await board.currentVersion('0081');

            await expect(service.reposition('0081', {})).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('"beforeId"/"afterId" must say where it lands') },
            });
            // The refusal must not have written a position.
            expect((await board.read('0081')).frontmatter.position).toBeUndefined();
            expect(await board.currentVersion('0081')).toBe(versionBefore);
            expect(events.append).not.toHaveBeenCalled();
        });

        it('still ranks with both neighbours omitted when the column genuinely holds only this card', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');

            const detail = await service.reposition('0080', {});

            expect(detail.position).toBe(POSITION_GAP);
        });

        it('refuses beforeId and afterId naming the same card, since a card cannot come both before and after one neighbour', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0089', { stage: 'parking-lot' }), 'seed');

            await expect(service.reposition('0089', { beforeId: '0080', afterId: '0080' })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('"0080" does not come before "0080"') },
            });
        });

        it('refuses beforeId/afterId given in the reverse of their actual column order, with a 400 naming both', async () => {
            const { board, service } = freshBoard();
            // Actual column order (by id, both unpositioned): 0080, 0081, then 0089 being repositioned.
            await board.create(card('0080', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0081', { stage: 'parking-lot' }), 'seed');
            await board.create(card('0089', { stage: 'parking-lot' }), 'seed');

            // Named backwards: 0081 (which actually sorts after 0080) is claimed as coming before it.
            await expect(service.reposition('0089', { beforeId: '0081', afterId: '0080' })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('"0081" does not come before "0080"') },
            });
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

    describe('rename', () => {
        it('renames the title and records "Rename {id}: "{old}" → "{new}"" as the version message', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0080', { stage: 'implementing', title: 'Old title' }), 'seed');

            const detail = await service.rename('0080', { title: 'New title' });

            expect(detail.title).toBe('New title');
            const stored = await board.read('0080');
            expect(stored.frontmatter.title).toBe('New title');
            const versions = await board.versions('0080', 10);
            expect(versions[0].message).toBe('Rename 0080: "Old title" → "New title"');
        });

        it('touches only the title — stage, branch and retries are untouched, and no event is appended', async () => {
            const { board, events, service } = freshBoard();
            await board.create(
                card('0081', { stage: 'implementing', title: 'Old title', branch: 'card/0081-old', retries: { implementing: 1 } }),
                'seed',
            );

            await service.rename('0081', { title: 'New title' });

            const stored = await board.read('0081');
            expect(stored.frontmatter.stage).toBe('implementing');
            expect(stored.frontmatter.branch).toBe('card/0081-old');
            expect(stored.frontmatter.retries).toEqual({ implementing: 1 });
            expect(events.append).not.toHaveBeenCalled();
        });

        it('is a no-op — no write — when the title is unchanged', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0082', { title: 'Same title' }), 'seed');
            const versionBefore = await board.currentVersion('0082');

            const detail = await service.rename('0082', { title: 'Same title' });

            expect(detail.title).toBe('Same title');
            expect(await board.currentVersion('0082')).toBe(versionBefore);
        });

        it('trims surrounding whitespace before comparing and before storing', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0083', { title: 'Trimmed title' }), 'seed');
            const versionBefore = await board.currentVersion('0083');

            // Whitespace-padded but the same title underneath: still a no-op.
            const sameDetail = await service.rename('0083', { title: '  Trimmed title  ' });
            expect(sameDetail.title).toBe('Trimmed title');
            expect(await board.currentVersion('0083')).toBe(versionBefore);

            const changedDetail = await service.rename('0083', { title: '  Actually new  ' });
            expect(changedDetail.title).toBe('Actually new');
            const stored = await board.read('0083');
            expect(stored.frontmatter.title).toBe('Actually new');
        });

        it('refuses an empty title with a 400, writing nothing', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0084', { title: 'Keep me' }), 'seed');
            const versionBefore = await board.currentVersion('0084');

            await expect(service.rename('0084', { title: '' })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('cannot be empty') },
            });
            expect(await board.currentVersion('0084')).toBe(versionBefore);
        });

        it('refuses a whitespace-only title with a 400, writing nothing', async () => {
            const { board, service } = freshBoard();
            await board.create(card('0085', { title: 'Keep me' }), 'seed');
            const versionBefore = await board.currentVersion('0085');

            await expect(service.rename('0085', { title: '   ' })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('cannot be empty') },
            });
            expect(await board.currentVersion('0085')).toBe(versionBefore);
        });

        it('answers a card that does not exist with a 404, matching getById', async () => {
            const { service } = freshBoard();

            await expect(service.rename('missing', { title: 'New title' })).rejects.toMatchObject({ statusCode: 404 });
        });

        it(
            "refuses a rename when the current title's branch already carries commits, naming the branch and that renaming " +
                'would strand it, and writes nothing',
            async () => {
                const worktrees = {
                    reclaim: vi.fn(async () => {}),
                    branchName: vi.fn(() => 'card/0086-old-title'),
                    hasWork: vi.fn(async () => true),
                };
                const { board, service } = freshBoard(worktrees);
                await board.create(card('0086', { stage: 'implementing', title: 'Old title' }), 'seed');
                const versionBefore = await board.currentVersion('0086');

                await expect(service.rename('0086', { title: 'New title' })).rejects.toMatchObject({
                    statusCode: 400,
                    details: { reason: expect.stringContaining('card/0086-old-title') },
                });
                await expect(service.rename('0086', { title: 'New title' })).rejects.toMatchObject({
                    statusCode: 400,
                    details: { reason: expect.stringContaining('strand') },
                });

                // Computed from the card's *current* title, not the requested one.
                expect(worktrees.branchName).toHaveBeenCalledWith('0086', 'Old title');
                expect(worktrees.hasWork).toHaveBeenCalledWith('card/0086-old-title');

                expect(await board.currentVersion('0086')).toBe(versionBefore);
                const stored = await board.read('0086');
                expect(stored.frontmatter.title).toBe('Old title');
            },
        );

        it('allows renaming when the branch exists but carries no commits of its own', async () => {
            const worktrees = {
                reclaim: vi.fn(async () => {}),
                branchName: vi.fn(() => 'card/0087-old-title'),
                hasWork: vi.fn(async () => false),
            };
            const { board, service } = freshBoard(worktrees);
            await board.create(card('0087', { stage: 'backlog', title: 'Old title' }), 'seed');

            const detail = await service.rename('0087', { title: 'New title' });

            expect(detail.title).toBe('New title');
            const stored = await board.read('0087');
            expect(stored.frontmatter.title).toBe('New title');
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

    describe('approve — card 0127: now a thin planning-only front door onto `move`', () => {
        const withScope = (id: string, stage: string, body = '## Goal\n\nDo it.\n\n## Files in scope\n\n- src/a.ts\n') =>
            card(id, { stage }, body);

        it('refuses a card outside planning with a 400, writing nothing', async () => {
            const { board, service } = freshBoard();
            await board.create(withScope('0050', 'implementing'), 'seed');

            await expect(service.approve('0050')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('"implementing", not "planning"') },
            });
            const stored = await board.read('0050');
            expect(stored.frontmatter.stage).toBe('implementing');
            expect(stored.frontmatter.planVersionId).toBeUndefined();
        });

        it('refuses a card in backlog too — the old target of this refusal — since approving now only ever starts from planning', async () => {
            const { board, service } = freshBoard();
            await board.create(withScope('0055', 'backlog'), 'seed');

            await expect(service.approve('0055')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('"backlog", not "planning"') },
            });
        });

        /**
         * The plan draws this boundary explicitly: "A `parking-lot` → `backlog` promotion... is not
         * 'approving a plan' in the same sense, [and] goes through plain `wilson card move` instead."
         * `approve` must refuse a parking-lot card exactly as it refuses any other non-`planning`
         * stage — the promotion path is `move`, not this thin front door onto it.
         */
        it('refuses a parking-lot card too — its promotion into backlog goes through plain `move`, not this front door', async () => {
            const { board, service } = freshBoard();
            const planVersion = await board.create(withScope('0056', 'parking-lot'), 'seed');

            await expect(service.approve('0056')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('"parking-lot", not "planning"') },
            });
            const stored = await board.read('0056');
            expect(stored.frontmatter.stage).toBe('parking-lot');
            expect(stored.frontmatter.planVersionId).toBeUndefined();

            // The same card is still promotable — just not through `approve`: plain `move` pins it,
            // exactly as it does for any other source stage entering `backlog`.
            const detail = await service.move('0056', { stage: 'backlog' });
            expect(detail.stage).toBe('backlog');
            expect((await board.read('0056')).frontmatter.planVersionId).toBe(planVersion);
        });

        it('refuses a planning card whose plan has an empty "Files in scope", writing nothing — the refusal now lives in `move`', async () => {
            const { board, service } = freshBoard();
            await board.create(withScope('0051', 'planning', '## Goal\n\nDo it.\n\n## Files in scope\n\n'), 'seed');

            await expect(service.approve('0051')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('Files in scope') },
            });
            const stored = await board.read('0051');
            expect(stored.frontmatter.stage).toBe('planning');
            expect(stored.frontmatter.planVersionId).toBeUndefined();
        });

        it('answers a card that does not exist with a 404', async () => {
            const { service } = freshBoard();

            await expect(service.approve('missing')).rejects.toMatchObject({ statusCode: 404 });
        });

        it('pins the version that held the plan a human just read — the one before this write, not the one this write creates — and moves planning into backlog', async () => {
            const { board, events, service } = freshBoard();
            const approvedVersion = await board.create(withScope('0052', 'planning'), 'seed');

            const detail = await service.approve('0052');

            expect(detail.stage).toBe('backlog');

            const stored = await board.read('0052');
            expect(stored.frontmatter.stage).toBe('backlog');
            expect(stored.frontmatter.planVersionId).toBe(approvedVersion);

            const versionAfterApproval = await board.currentVersion('0052');
            expect(versionAfterApproval).not.toBe(approvedVersion);

            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    cardId: '0052',
                    stage: 'backlog',
                    type: 'transition.written',
                    payload: { from: 'planning', to: 'backlog', by: 'human', planVersionId: approvedVersion },
                }),
                expect.anything(),
            );
        });

        it('pins the plan text as it stood at approval, so a later edit does not change what a pinned read sees', async () => {
            const { board, service } = freshBoard();
            const approvedBody = '## Goal\n\nApprove me.\n\n## Files in scope\n\n- src/a.ts\n';
            await board.create(withScope('0053', 'planning', approvedBody), 'seed');

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

        /**
         * Card 0264. `start` reads `DAILY_OUTPUT_TOKEN_CEILING` before `whyNotDispatchable` even runs
         * — these are the ceiling's own tests, distinct from the checks above. A `SettingsStore` that
         * answers a real ceiling for that one key (and every other definition's own coded default
         * otherwise, so `whyNotDispatchable`'s own path is undisturbed) lets each test control exactly
         * what `start` sees without touching `freshBoard`'s default of "no ceiling" everywhere else.
         */
        const settingsWithCeiling = (ceiling: number): SettingsStore =>
            ({
                get: vi.fn(async (definition: { key: string; defaultValue: unknown }) =>
                    definition.key === DAILY_OUTPUT_TOKEN_CEILING.key ? ceiling : definition.defaultValue,
                ),
                set: vi.fn(async () => undefined),
            }) as unknown as SettingsStore;

        // AC1 (the other half of it, alongside the poller's own): a ceiling of 0 never queries usage
        // at all — proven directly, not just inferred from every other test above surviving an
        // `events.outputTokensSince` that would throw if it were ever reached.
        it('AC1: a ceiling of 0 never calls outputTokensSince, and starts exactly as it does today', async () => {
            const { board, broker, events, service } = freshBoard(undefined, {}, undefined, settingsWithCeiling(0));
            await board.create(card('0064', { stage: 'implementing' }), 'seed');

            const detail = await service.start('0064');

            expect(detail.stage).toBe('implementing');
            expect(events.outputTokensSince).not.toHaveBeenCalled();
            expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0064', stageName: 'implementing' });
        });

        // AC4, "under it": spend below a real ceiling behaves exactly as an unset one does.
        it('AC4: spend below the ceiling starts the card exactly as it does today', async () => {
            const { board, config, broker, events, service } = freshBoard(undefined, {}, undefined, settingsWithCeiling(1000));
            (events.outputTokensSince as ReturnType<typeof vi.fn>).mockResolvedValue(500);
            await board.create(card('0065', { stage: 'implementing' }), 'seed');

            const detail = await service.start('0065');

            expect(detail.stage).toBe('implementing');
            expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0065', stageName: 'implementing' });

            // AC6: asked about this project's own spend, over a window starting at local midnight —
            // the instant passed is its own start-of-day, not merely "some time in the past".
            const [project, since] = (events.outputTokensSince as ReturnType<typeof vi.fn>).mock.calls[0] as [string, DateTime];
            expect(project).toBe(config.project);
            expect(since.startOf('day').toMillis()).toBe(since.toMillis());
        });

        // AC4, "over it": refuses with a 400 naming both the ceiling and today's figure, writing and
        // enqueueing nothing — the same refusal shape whyNotDispatchable's own refusals above take.
        it('AC4: refuses to start when today’s spend is at or over the ceiling, naming both figures, and enqueues nothing', async () => {
            const { board, broker, cardJobs, events, service } = freshBoard(undefined, {}, undefined, settingsWithCeiling(1000));
            (events.outputTokensSince as ReturnType<typeof vi.fn>).mockResolvedValue(1000);
            await board.create(card('0066', { stage: 'implementing' }), 'seed');

            await expect(service.start('0066')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('has spent 1000 output tokens today, at or over its daily ceiling of 1000') },
            });

            expect(broker.send).not.toHaveBeenCalled();
            expect(await cardJobs.inFlight('0066')).toBeUndefined();
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
            const { board, config, broker, cardJobs, service } = freshBoard(
                { reclaim: vi.fn(async () => {}) },
                { getJob: vi.fn(async () => ({ id: 'job-42', name: 'card.stage', state: 'active', data: {} })) },
                runningCards,
            );
            await board.create(card('0071', { stage: 'implementing' }), 'seed');
            await cardJobs.record('0071', 'job-42');
            runningCards.add(config.project, '0071');

            await expect(service.release('0071')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('job-42') },
            });
            expect(broker.cancel).not.toHaveBeenCalled();
            expect(await cardJobs.inFlight('0071')).toBe('job-42');
        });

        /**
         * Card 0149: `RunningCards` entries are keyed by `(project, cardId)`, and this service stays
         * single-project (project-awareness is the next card's HTTP surface, out of scope here) —
         * `service.release` must only treat the claim as genuinely in-flight *in this process* when
         * the running entry belongs to `this.boardConfig.project`. A same-numbered card id running
         * under some other registered project (card ids are per-project, both boards can have an
         * `0071`) must not falsely block this project's own release.
         */
        it('releases normally when a same-numbered card is running, but under a different project', async () => {
            const runningCards = new RunningCards();
            const { board, cardJobs, broker, service } = freshBoard(
                { reclaim: vi.fn(async () => {}) },
                { getJob: vi.fn(async () => ({ id: 'job-42', name: 'card.stage', state: 'active', data: {} })) },
                runningCards,
            );
            await board.create(card('0071', { stage: 'implementing' }), 'seed');
            await cardJobs.record('0071', 'job-42');
            // Some other registered project happens to be mid-run on its own card `0071` right now —
            // this must not be mistaken for *this* project's card 0071 being in flight.
            runningCards.add('some-other-project', '0071');

            const detail = await service.release('0071');

            expect(detail.stage).toBe('implementing');
            expect(broker.cancel).toHaveBeenCalledWith('card.stage', 'job-42');
            expect(await cardJobs.inFlight('0071')).toBeUndefined();
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

    /**
     * Card 0143. `merge` is the daemon's own hand-merge: compute the branch merged into `main`
     * without a checkout (`worktrees.computeMerge`), prove it against the `testing` stage's
     * configured suite in a throwaway worktree, then land it (`worktrees.commitMerge` +
     * `worktrees.landMerge`) and move the card — or flag it and leave it in `ready`. `worktrees`
     * itself is a double here (this is `board.write.service`'s own unit, not `WorktreeManager`'s —
     * see `worktree.manager.test.ts` for `computeMerge`/`commitMerge`/`landMerge` against real git),
     * but `proveMerge`'s suite proof runs the real `runConfiguredCommand` against a real script, so
     * the pass/fail branch is exercised as actually written, not asserted by a mock agreeing with
     * itself.
     */
    describe('merge', () => {
        /**
         * A stage config of its own, separate from the shared `stageConfigs` above (which has no
         * `testCommand`, so `proveMerge` would always refuse with "no testCommand configured" against
         * it) — one per call, carrying the suite command that test wants proved.
         */
        const mergeStageConfigs = (testCommand: string): StaticStageConfigStore =>
            new StaticStageConfigStore(
                [
                    'stages:',
                    '  - name: testing',
                    '    mode: agent',
                    '    model: claude-opus',
                    '    instructions: test the thing',
                    `    testCommand: ${testCommand}`,
                    '    onPass: merged',
                    '    onFail: testing',
                    '',
                ].join('\n'),
            );

        const scriptExiting = async (code: number): Promise<string> => {
            const dir = await mkdtemp(join(tmpdir(), 'board-write-service-merge-script-'));
            const path = join(dir, 'suite.js');
            await writeFile(path, `process.exit(${code});\n`, 'utf8');
            return path;
        };

        /**
         * A `merge`-specific double: `resolveBranch`/`computeMerge`/`commitMerge`/`landMerge` stand
         * in for the git plumbing (covered directly in `worktree.manager.test.ts`), while `create`
         * hands `proveMerge` a real, existing directory so the real `runConfiguredCommand` it runs
         * has somewhere to spawn its process — the scratch worktree's *content* is not what these
         * tests are about.
         */
        const mergeWorktrees = (overrides: Record<string, unknown> = {}) => ({
            resolveBranch: vi.fn(() => 'card/0090-thing'),
            computeMerge: vi.fn(async () => ({ ok: true, treeSha: 'tree-sha', targetSha: 'main-sha-before', branchSha: 'branch-sha' })),
            commitMerge: vi.fn(async () => 'merge-commit-sha'),
            landMerge: vi.fn(async () => ({ ok: true })),
            create: vi.fn(async () => ({ path: tmpdir(), branch: 'card/0090-thing-merge-check', baseSha: 'merge-commit-sha' })),
            reclaim: vi.fn(async () => {}),
            // Card 0144: `ensureIntegrationBranch`/`headSha` only matter when dry run is on — a
            // default that answers with the real branch name and an unmoving sha lets every test
            // that isn't about dry run itself ignore them entirely.
            ensureIntegrationBranch: vi.fn(async () => DRY_RUN_INTEGRATION_BRANCH),
            headSha: vi.fn(async () => 'main-sha-before'),
            // Card 0238: `merge` calls this before `computeMerge` whenever `RE_REVIEW_ON_MERGE` is
            // on. A default answering "nothing moved" lets every test that isn't about the re-review
            // check itself ignore it entirely, the same posture the other defaults above take.
            overlapSinceFork: vi.fn(async () => ({ base: 'base-sha', movedUnder: [] })),
            ...overrides,
        });

        /**
         * Card 0144, extended by card 0238. `merge` reads two independent settings through
         * `SettingsStore` fresh on every call: `DRY_RUN_ENABLED` and (as of card 0238)
         * `RE_REVIEW_ON_MERGE`. This fake distinguishes them by key rather than answering one boolean
         * for every `get` — a single shared boolean would make turning dry run on silently turn
         * re-review on too (and vice versa), which is not what either setting's own default does in
         * production. Both default off so every test that predates card 0238 keeps exercising exactly
         * the behaviour it always has; the tests that care about either pass it explicitly.
         */
        const fakeSettings = (dryRun: boolean, reReviewOnMerge = false): SettingsStore =>
            ({
                get: vi.fn(async (setting: { key: string }) => (setting.key === RE_REVIEW_ON_MERGE.key ? reReviewOnMerge : dryRun)),
            }) as unknown as SettingsStore;

        const freshMergeBoard = (
            worktrees: ReturnType<typeof mergeWorktrees>,
            stages: StaticStageConfigStore,
            dryRun = false,
            reReviewOnMerge = false,
        ) => {
            const events = { append: vi.fn(async () => {}) };
            const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
            const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
            const logger = fakeLogger();
            const broker = { send: vi.fn(async () => 'job-1'), cancel: vi.fn(async () => {}), getJob: vi.fn(async () => null) };
            const cardJobs = new CardJobs(config, db, broker as unknown as JobBroker);
            const runningCards = new RunningCards();
            const service = new BoardWriteService(
                board,
                config,
                worktrees as unknown as WorktreeManager,
                events as unknown as EventLog,
                logger,
                cardJobs,
                broker as unknown as JobBroker,
                runningCards,
                fakeSettings(dryRun, reReviewOnMerge),
                stages,
            );
            return { board, events, service };
        };

        it('refuses a card that is not in ready, touching none of the git plumbing', async () => {
            const worktrees = mergeWorktrees();
            const { board, service } = freshMergeBoard(worktrees, stageConfigs);
            await board.create(card('0090', { stage: 'implementing' }), 'seed');

            await expect(service.merge('0090')).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('not "ready"') },
            });
            expect(worktrees.computeMerge).not.toHaveBeenCalled();
        });

        it('flags a conflicting merge, leaves the card in ready with its retries untouched, and lands nothing', async () => {
            const worktrees = mergeWorktrees({
                computeMerge: vi.fn(async () => ({ ok: false, conflicts: ['src/index.ts', 'src/other.ts'], raw: 'CONFLICT (content): ...' })),
            });
            const { board, service } = freshMergeBoard(worktrees, stageConfigs);
            await board.create(card('0091', { stage: 'ready', retries: { testing: 1 } }), 'seed');

            const result = await service.merge('0091');

            expect(result.merged).toBe(false);
            expect(result.reason).toContain('src/index.ts');
            expect(result.reason).toContain('src/other.ts');
            expect(worktrees.commitMerge).not.toHaveBeenCalled();
            expect(worktrees.landMerge).not.toHaveBeenCalled();

            const stored = await board.read('0091');
            expect(stored.frontmatter.stage).toBe('ready');
            expect(stored.frontmatter.needsHuman).toBe(true);
            expect(stored.frontmatter.needsHumanReason).toContain('src/index.ts');
            expect(stored.frontmatter.retries).toEqual({ testing: 1 });
        });

        it('does not land a merge whose suite fails, and leaves the card flagged in ready', async () => {
            const failing = await scriptExiting(1);
            const mergeStages = mergeStageConfigs(`node ${failing}`);
            const worktrees = mergeWorktrees();
            const { board, service } = freshMergeBoard(worktrees, mergeStages);
            await board.create(card('0092', { stage: 'ready' }), 'seed');

            const result = await service.merge('0092');

            expect(result.merged).toBe(false);
            expect(result.reason).toContain('fails the suite');
            expect(worktrees.landMerge).not.toHaveBeenCalled();
            // The scratch worktree is still reclaimed even though the suite failed.
            expect(worktrees.reclaim).toHaveBeenCalledWith('0092-merge-check');

            const stored = await board.read('0092');
            expect(stored.frontmatter.stage).toBe('ready');
            expect(stored.frontmatter.needsHuman).toBe(true);
        });

        /**
         * Card 0261, AC6. `proveMerge` gets the same one-rerun rule `TestingVerifier.judgeRedRun`
         * already applies to the testing stage: a red merge-check suite is reran, once, against just
         * the files its report named as failing, before `flagMergeFailure` is believed. These two
         * tests use a real script rather than a double, logging every invocation's extra argv to
         * `calls.log` so the assertions can tell a genuine rerun happened from a suite that was only
         * ever asked once — proof neither test could pass against the pre-change `proveMerge`, which
         * never reran anything.
         */
        const writeFakeMergeSuite = async (
            dir: string,
            opts: { reportPath: string; tests: Array<{ file: string; name: string }>; rerunExit: number },
        ): Promise<string> => {
            const report = {
                numTotalTests: opts.tests.length,
                numPassedTests: 0,
                numFailedTests: opts.tests.length,
                numPendingTests: 0,
                numTodoTests: 0,
                testResults: opts.tests.map(t => ({
                    name: join(dir, t.file),
                    status: 'failed',
                    assertionResults: [{ status: 'failed', fullName: t.name }],
                })),
            };
            const scriptPath = join(dir, 'suite.cjs');
            const body = [
                "const fs = require('fs');",
                `fs.appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
                'if (process.argv.length > 2) {',
                `  process.exit(${opts.rerunExit});`,
                '}',
                `fs.writeFileSync(${JSON.stringify(join(dir, opts.reportPath))}, ${JSON.stringify(JSON.stringify(report))});`,
                'process.exit(1);',
            ].join('\n');
            await writeFile(scriptPath, body, 'utf8');
            return scriptPath;
        };

        it('AC6: merges the card when the merge-check suite fails and its rerun of the failed file is green, recording a merge-check test.flaky event', async () => {
            const dir = await mkdtemp(join(tmpdir(), 'board-write-service-merge-flaky-'));
            const scriptPath = await writeFakeMergeSuite(dir, {
                reportPath: 'report.json',
                tests: [{ file: 'thing.test.ts', name: 'flaky test' }],
                rerunExit: 0,
            });
            const mergeStages = new StaticStageConfigStore(
                [
                    'stages:',
                    '  - name: testing',
                    '    mode: agent',
                    '    model: claude-opus',
                    '    instructions: test the thing',
                    `    testCommand: node ${scriptPath}`,
                    '    testReportPath: report.json',
                    '    onPass: merged',
                    '    onFail: testing',
                    '',
                ].join('\n'),
            );
            const worktrees = mergeWorktrees({ create: vi.fn(async () => ({ path: dir, branch: 'card/0197-merge-check', baseSha: 'merge-commit-sha' })) });
            const { board, events, service } = freshMergeBoard(worktrees, mergeStages);
            await board.create(card('0197', { stage: 'ready' }), 'seed');

            const result = await service.merge('0197');

            expect(result.merged).toBe(true);
            const stored = await board.read('0197');
            expect(stored.frontmatter.stage).toBe('merged');
            expect(stored.frontmatter.needsHuman).toBe(false);
            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    cardId: '0197',
                    type: 'test.flaky',
                    payload: { tests: ['thing.test.ts > flaky test'], run: 'merge-check' },
                }),
            );

            const calls = (await readFile(join(dir, 'calls.log'), 'utf8')).trim().split('\n');
            expect(calls).toHaveLength(2);
        });

        it('AC6: leaves the card flagged, calling flagMergeFailure, when the merge-check suite fails and its rerun fails too', async () => {
            const dir = await mkdtemp(join(tmpdir(), 'board-write-service-merge-red-'));
            const scriptPath = await writeFakeMergeSuite(dir, {
                reportPath: 'report.json',
                tests: [{ file: 'thing.test.ts', name: 'really broken' }],
                rerunExit: 1,
            });
            const mergeStages = new StaticStageConfigStore(
                [
                    'stages:',
                    '  - name: testing',
                    '    mode: agent',
                    '    model: claude-opus',
                    '    instructions: test the thing',
                    `    testCommand: node ${scriptPath}`,
                    '    testReportPath: report.json',
                    '    onPass: merged',
                    '    onFail: testing',
                    '',
                ].join('\n'),
            );
            const worktrees = mergeWorktrees({ create: vi.fn(async () => ({ path: dir, branch: 'card/0198-merge-check', baseSha: 'merge-commit-sha' })) });
            const { board, events, service } = freshMergeBoard(worktrees, mergeStages);
            await board.create(card('0198', { stage: 'ready' }), 'seed');

            const result = await service.merge('0198');

            expect(result.merged).toBe(false);
            expect(result.reason).toContain('fails the suite');
            const stored = await board.read('0198');
            expect(stored.frontmatter.stage).toBe('ready');
            expect(stored.frontmatter.needsHuman).toBe(true);
            expect(events.append).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'test.flaky' }));

            // Proves the rerun actually ran, not just that the outcome matches today's.
            const calls = (await readFile(join(dir, 'calls.log'), 'utf8')).trim().split('\n');
            expect(calls).toHaveLength(2);
        });

        it('lands a clean merge whose suite passes, and moves the card to merged', async () => {
            const passing = await scriptExiting(0);
            const mergeStages = mergeStageConfigs(`node ${passing}`);
            const worktrees = mergeWorktrees();
            const { board, service } = freshMergeBoard(worktrees, mergeStages);
            await board.create(card('0093', { stage: 'ready' }), 'seed');

            const result = await service.merge('0093');

            expect(result.merged).toBe(true);
            expect(result.commit).toBe('merge-commit-sha');
            expect(result.reason).toBeUndefined();
            expect(worktrees.commitMerge).toHaveBeenCalledWith('main-sha-before', 'branch-sha', 'tree-sha', expect.stringContaining('0093'));
            expect(worktrees.landMerge).toHaveBeenCalledWith('main-sha-before', 'merge-commit-sha', 'main');
            expect(worktrees.ensureIntegrationBranch).not.toHaveBeenCalled();
            expect(worktrees.reclaim).toHaveBeenCalledWith('0093-merge-check');

            const stored = await board.read('0093');
            expect(stored.frontmatter.stage).toBe('merged');
            expect(stored.frontmatter.needsHuman).toBe(false);
        });

        it('reports failure, not success, and leaves the card flagged, when the ref does not actually move', async () => {
            const passing = await scriptExiting(0);
            const mergeStages = mergeStageConfigs(`node ${passing}`);
            const worktrees = mergeWorktrees({
                landMerge: vi.fn(async () => ({ ok: false, reason: 'main did not move: update-ref refused the compare-and-swap' })),
            });
            const { board, service } = freshMergeBoard(worktrees, mergeStages);
            await board.create(card('0094', { stage: 'ready' }), 'seed');

            const result = await service.merge('0094');

            expect(result.merged).toBe(false);
            expect(result.reason).toBe('main did not move: update-ref refused the compare-and-swap');

            const stored = await board.read('0094');
            expect(stored.frontmatter.stage).toBe('ready');
            expect(stored.frontmatter.needsHuman).toBe(true);
            expect(stored.frontmatter.needsHumanReason).toBe('main did not move: update-ref refused the compare-and-swap');
        });

        /**
         * Card 0238. `merge` asks `overlapSinceFork` before it ever touches `computeMerge` — these
         * tests exercise that ordering and the send-back/cap/off-switch decisions built on top of it,
         * with `worktrees.overlapSinceFork` doubled (real git behind it is `worktree.manager.test.ts`'s
         * own `overlapSinceFork` describe block, AC6).
         */
        describe('re-review on merge — card 0238', () => {
            it('sends the card back to review instead of computing the merge, when main moved under a file the card changed (AC1)', async () => {
                const worktrees = mergeWorktrees({
                    overlapSinceFork: vi.fn(async () => ({ base: 'base-sha', movedUnder: ['src/index.ts'] })),
                });
                const { board, events, service } = freshMergeBoard(worktrees, stageConfigs, false, true);
                await board.create(card('0101', { stage: 'ready' }), 'seed');

                const result = await service.merge('0101');

                expect(result.merged).toBe(false);
                expect(result.reason).toContain('src/index.ts');
                expect(result.reason).toContain('round 1 of 2');
                expect(worktrees.computeMerge).not.toHaveBeenCalled();

                const stored = await board.read('0101');
                expect(stored.frontmatter.stage).toBe('review');
                expect(stored.frontmatter.retries['review:re-review']).toBe(1);

                // AC5: the transition is a runner-authored send-back, not an ordinary human move —
                // `by: 'runner'`, carrying the reason, not `move`'s shape.
                expect(events.append).toHaveBeenCalledWith(
                    expect.objectContaining({
                        cardId: '0101',
                        stage: 'review',
                        type: 'transition.written',
                        payload: { from: 'ready', to: 'review', by: 'runner', reason: result.reason },
                    }),
                    expect.anything(),
                );
            });

            it('proceeds to computeMerge as usual when overlapSinceFork finds nothing under the card’s own files (AC2)', async () => {
                const passing = await scriptExiting(0);
                const mergeStages = mergeStageConfigs(`node ${passing}`);
                const worktrees = mergeWorktrees({
                    overlapSinceFork: vi.fn(async () => ({ base: 'base-sha', movedUnder: [] })),
                });
                const { board, service } = freshMergeBoard(worktrees, mergeStages, false, true);
                await board.create(card('0102', { stage: 'ready' }), 'seed');

                const result = await service.merge('0102');

                expect(worktrees.overlapSinceFork).toHaveBeenCalled();
                expect(worktrees.computeMerge).toHaveBeenCalled();
                expect(result.merged).toBe(true);
                const stored = await board.read('0102');
                expect(stored.frontmatter.stage).toBe('merged');
            });

            it('never calls overlapSinceFork and proceeds to computeMerge when the setting is off, even though main moved under the card’s files (AC3)', async () => {
                const passing = await scriptExiting(0);
                const mergeStages = mergeStageConfigs(`node ${passing}`);
                const worktrees = mergeWorktrees({
                    overlapSinceFork: vi.fn(async () => ({ base: 'base-sha', movedUnder: ['src/index.ts'] })),
                });
                const { board, service } = freshMergeBoard(worktrees, mergeStages, false, false);
                await board.create(card('0103', { stage: 'ready' }), 'seed');

                const result = await service.merge('0103');

                expect(worktrees.overlapSinceFork).not.toHaveBeenCalled();
                expect(worktrees.computeMerge).toHaveBeenCalled();
                expect(result.merged).toBe(true);
                const stored = await board.read('0103');
                expect(stored.frontmatter.stage).toBe('merged');
            });

            it('flags a human instead of sending back again once review:re-review has already reached its cap (AC4)', async () => {
                const worktrees = mergeWorktrees({
                    overlapSinceFork: vi.fn(async () => ({ base: 'base-sha', movedUnder: ['src/index.ts', 'src/other.ts'] })),
                });
                const { board, service } = freshMergeBoard(worktrees, stageConfigs, false, true);
                await board.create(card('0104', { stage: 'ready', retries: { 'review:re-review': 2 } }), 'seed');

                const result = await service.merge('0104');

                expect(result.merged).toBe(false);
                expect(result.reason).toContain('src/index.ts');
                expect(result.reason).toContain('src/other.ts');
                expect(worktrees.computeMerge).not.toHaveBeenCalled();

                const stored = await board.read('0104');
                expect(stored.frontmatter.stage).toBe('ready');
                expect(stored.frontmatter.needsHuman).toBe(true);
                expect(stored.frontmatter.needsHumanReason).toContain('src/index.ts');
                expect(stored.frontmatter.needsHumanReason).toContain('src/other.ts');
                // The cap check spends no further round — this is the same count it already found.
                expect(stored.frontmatter.retries['review:re-review']).toBe(2);
            });
        });

        /**
         * Review finding on card 0143: `proveMerge` cuts its scratch worktree on branch
         * `card/{id}-merge-check` and reclaims the worktree, but the branch itself is a leftover
         * `WorktreeManager.create` (via `git worktree add -B`) leaves behind in `codeRoot` — reclaim
         * only removes the worktree, not the branch that was checked out in it. Every `worktrees`
         * double used above stubs `create`/`reclaim` away entirely, so none of them could catch a
         * regression here; this test uses the real `WorktreeManager` against a real `codeRoot` so the
         * branch it creates is a real git ref, and asserts it is gone afterward — the same way
         * `PlanService.close` deletes its own throwaway branch after reclaiming that session's
         * worktree.
         */
        it("deletes proveMerge's own scratch branch from codeRoot once the merge is proved, leaving no leftover ref behind", async () => {
            const passing = await scriptExiting(0);
            const mergeStages = mergeStageConfigs(`node ${passing}`);

            const base = await mkdtemp(join(tmpdir(), 'board-write-service-merge-branch-'));
            const codeRoot = join(base, 'code');
            await mkdir(join(codeRoot, 'src'), { recursive: true });
            await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
            await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
            await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
            await writeFile(join(codeRoot, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

            const config = new StaticBoardConfig(uniqueProject(), codeRoot, join(base, 'worktrees'), join(base, 'run'));
            // The real thing, not a double: computeMerge/commitMerge/create/reclaim all run against
            // codeRoot's actual git state, the same idiom worktree.manager.test.ts uses, so the branch
            // `create` leaves behind is a real ref this test can check for afterward.
            const worktrees = new WorktreeManager(config, fakeLogger());

            const cardWorktree = await worktrees.create('0095', 'card/0095-thing');
            await writeFile(join(cardWorktree.path, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');
            await worktrees.commit(cardWorktree, '0095: implementing');

            const events = { append: vi.fn(async () => {}) };
            const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
            const broker = { send: vi.fn(async () => 'job-1'), cancel: vi.fn(async () => {}), getJob: vi.fn(async () => null) };
            const cardJobs = new CardJobs(config, db, broker as unknown as JobBroker);
            const service = new BoardWriteService(
                board,
                config,
                worktrees,
                events as unknown as EventLog,
                fakeLogger(),
                cardJobs,
                broker as unknown as JobBroker,
                new RunningCards(),
                fakeSettings(false),
                mergeStages,
            );
            await board.create(card('0095', { stage: 'ready', branch: 'card/0095-thing' }), 'seed');

            const result = await service.merge('0095');

            expect(result.merged).toBe(true);
            const { stdout } = await exec('git', ['branch', '--list', 'card/0095-merge-check'], { cwd: codeRoot });
            expect(stdout.trim()).toBe('');
        });

        /**
         * Card 0144. Same double-based idiom as the tests above, but with dry run switched on: proves
         * `merge` reads `WorktreeManager.ensureIntegrationBranch` for its target instead of `'main'`,
         * lands there, reads `main` before and after to confirm the rehearsal never touched it, and
         * says plainly in the result that it was a rehearsal — while still moving the card to `merged`
         * (this card's Constraints: withholding that would make every dependent card undispatchable).
         */
        it('computes and lands against the integration branch when dry run is on, leaves main unread for anything but the before/after check, and says it was a rehearsal', async () => {
            const passing = await scriptExiting(0);
            const mergeStages = mergeStageConfigs(`node ${passing}`);
            const worktrees = mergeWorktrees();
            const { board, service } = freshMergeBoard(worktrees, mergeStages, true);
            await board.create(card('0099', { stage: 'ready' }), 'seed');

            const result = await service.merge('0099');

            expect(worktrees.ensureIntegrationBranch).toHaveBeenCalled();
            expect(worktrees.computeMerge).toHaveBeenCalledWith('card/0090-thing', DRY_RUN_INTEGRATION_BRANCH);
            expect(worktrees.landMerge).toHaveBeenCalledWith('main-sha-before', 'merge-commit-sha', DRY_RUN_INTEGRATION_BRANCH);
            // headSha is read exactly twice: once before anything runs, once after landing, to prove
            // main did not move — never used as the merge target itself.
            expect(worktrees.headSha).toHaveBeenCalledTimes(2);

            expect(result.merged).toBe(true);
            expect(result.commit).toBe('merge-commit-sha');
            expect(result.reason).toMatch(/dry run/i);
            expect(result.reason).toContain(DRY_RUN_INTEGRATION_BRANCH);

            const stored = await board.read('0099');
            expect(stored.frontmatter.stage).toBe('merged');
        });

        it('throws rather than silently reporting success when a dry-run merge somehow moves main, and never reaches move', async () => {
            const passing = await scriptExiting(0);
            const mergeStages = mergeStageConfigs(`node ${passing}`);
            const headShas = ['main-before', 'main-moved-unexpectedly'];
            const worktrees = mergeWorktrees({ headSha: vi.fn(async () => headShas.shift()) });
            const { board, service } = freshMergeBoard(worktrees, mergeStages, true);
            await board.create(card('0100', { stage: 'ready' }), 'seed');

            await expect(service.merge('0100')).rejects.toThrow(/main moved/);

            // The throw happens before the card is moved to merged — landing already happened, but
            // the card transition itself must not be reported as having succeeded.
            const stored = await board.read('0100');
            expect(stored.frontmatter.stage).toBe('ready');
        });

        /**
         * Card 0144's own acceptance criteria, exercised end to end against real git rather than a
         * double: main's sha is identical before and after, the integration branch's tip carries the
         * card's work, and the card still ends in `merged`.
         */
        it('rehearses a merge end to end: main is untouched, the integration branch carries the work, and the card still reaches merged', async () => {
            const passing = await scriptExiting(0);
            const mergeStages = mergeStageConfigs(`node ${passing}`);

            const base = await mkdtemp(join(tmpdir(), 'board-write-service-dry-run-'));
            const codeRoot = join(base, 'code');
            await mkdir(join(codeRoot, 'src'), { recursive: true });
            await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
            await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
            await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
            await writeFile(join(codeRoot, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

            const config = new StaticBoardConfig(uniqueProject(), codeRoot, join(base, 'worktrees'), join(base, 'run'));
            const worktrees = new WorktreeManager(config, fakeLogger());

            const cardWorktree = await worktrees.create('0096', 'card/0096-thing');
            await writeFile(join(cardWorktree.path, 'src', 'feature.ts'), 'export const feature = 1;\n', 'utf8');
            await worktrees.commit(cardWorktree, '0096: implementing');

            const events = { append: vi.fn(async () => {}) };
            const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
            const broker = { send: vi.fn(async () => 'job-1'), cancel: vi.fn(async () => {}), getJob: vi.fn(async () => null) };
            const cardJobs = new CardJobs(config, db, broker as unknown as JobBroker);
            const service = new BoardWriteService(
                board,
                config,
                worktrees,
                events as unknown as EventLog,
                fakeLogger(),
                cardJobs,
                broker as unknown as JobBroker,
                new RunningCards(),
                fakeSettings(true),
                mergeStages,
            );
            await board.create(card('0096', { stage: 'ready', branch: 'card/0096-thing' }), 'seed');

            const mainBefore = (await exec('git', ['rev-parse', 'main'], { cwd: codeRoot })).stdout.trim();

            const result = await service.merge('0096');

            expect(result.merged).toBe(true);
            expect(result.reason).toMatch(/dry run/i);

            const mainAfter = (await exec('git', ['rev-parse', 'main'], { cwd: codeRoot })).stdout.trim();
            expect(mainAfter).toBe(mainBefore);

            const integrationFile = await exec('git', ['show', `refs/heads/${DRY_RUN_INTEGRATION_BRANCH}:src/feature.ts`], { cwd: codeRoot });
            expect(integrationFile.stdout).toBe('export const feature = 1;\n');

            const stored = await board.read('0096');
            expect(stored.frontmatter.stage).toBe('merged');
        });

        /**
         * The composing half of card 0144's acceptance criteria: a second card's dry-run merge must
         * see the first's result on the integration branch, and a card depending on the first must
         * become dispatchable — proven by actually merging both and then reading the resulting board
         * state through `unsatisfiedDependencies`, not by asserting the dependency rule in isolation.
         */
        it('composes two dry-run merges on the integration branch, and lets a dependent card become dispatchable', async () => {
            const passing = await scriptExiting(0);
            const mergeStages = mergeStageConfigs(`node ${passing}`);

            const base = await mkdtemp(join(tmpdir(), 'board-write-service-dry-run-compose-'));
            const codeRoot = join(base, 'code');
            await mkdir(join(codeRoot, 'src'), { recursive: true });
            await exec('git', ['init', '-q', '-b', 'main'], { cwd: codeRoot });
            await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: codeRoot });
            await exec('git', ['config', 'user.name', 'Test'], { cwd: codeRoot });
            await writeFile(join(codeRoot, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
            await exec('git', ['add', '-A'], { cwd: codeRoot });
            await exec('git', ['commit', '-q', '-m', 'initial'], { cwd: codeRoot });

            const config = new StaticBoardConfig(uniqueProject(), codeRoot, join(base, 'worktrees'), join(base, 'run'));
            const worktrees = new WorktreeManager(config, fakeLogger());
            const events = { append: vi.fn(async () => {}) };
            const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
            const broker = { send: vi.fn(async () => 'job-1'), cancel: vi.fn(async () => {}), getJob: vi.fn(async () => null) };
            const cardJobs = new CardJobs(config, db, broker as unknown as JobBroker);
            const service = new BoardWriteService(
                board,
                config,
                worktrees,
                events as unknown as EventLog,
                fakeLogger(),
                cardJobs,
                broker as unknown as JobBroker,
                new RunningCards(),
                fakeSettings(true),
                mergeStages,
            );

            // Card 0097 is cut from main before anything has landed on the integration branch.
            const worktreeA = await worktrees.create('0097', 'card/0097-thing');
            await writeFile(join(worktreeA.path, 'src', 'feature-a.ts'), 'export const a = 1;\n', 'utf8');
            await worktrees.commit(worktreeA, '0097: implementing');
            await board.create(card('0097', { stage: 'ready', branch: 'card/0097-thing' }), 'seed');

            const resultA = await service.merge('0097');
            expect(resultA.merged).toBe(true);

            // Card 0098 depends on 0097 and is also cut from main — its own file never touches
            // 0097's, so the only way both files end up on the integration branch together is if
            // 0098's merge is computed against the branch's tip (which already carries 0097's dry-run
            // result), not against bare main.
            const worktreeB = await worktrees.create('0098', 'card/0098-thing');
            await writeFile(join(worktreeB.path, 'src', 'feature-b.ts'), 'export const b = 1;\n', 'utf8');
            await worktrees.commit(worktreeB, '0098: implementing');
            await board.create(card('0098', { stage: 'ready', branch: 'card/0098-thing', dependsOn: ['0097'] }), 'seed');

            const resultB = await service.merge('0098');
            expect(resultB.merged).toBe(true);

            const fileA = await exec('git', ['show', `refs/heads/${DRY_RUN_INTEGRATION_BRANCH}:src/feature-a.ts`], { cwd: codeRoot });
            expect(fileA.stdout).toBe('export const a = 1;\n');
            const fileB = await exec('git', ['show', `refs/heads/${DRY_RUN_INTEGRATION_BRANCH}:src/feature-b.ts`], { cwd: codeRoot });
            expect(fileB.stdout).toBe('export const b = 1;\n');

            // 0098's merge commit carries 0097's own merge commit as a parent — proof it was computed
            // against the first result, not against bare main.
            const parentsOfB = (await exec('git', ['show', '-s', '--format=%P', resultB.commit as string], { cwd: codeRoot })).stdout
                .trim()
                .split(' ');
            expect(parentsOfB).toContain(resultA.commit);

            // The dependency rule itself only checks for `stage === 'merged'` — this proves a dry-run
            // merge actually produces that, by reading the real board state back and asking the real
            // rule, rather than trusting the rule and the merge's `merged: true` never to diverge.
            const cards = await board.list();
            const cardB = cards.find(c => c.frontmatter.id === '0098');
            if (!cardB) throw new Error('expected card 0098 on the board');
            expect(unsatisfiedDependencies(cardB, cards)).toEqual([]);
        });
    });

    describe('recordFindings', () => {
        // Card 0266. A `ready` stage whose `onFail` is deliberately not `implementing` — the only
        // way a test can tell "read from the live stage config" (AC3) apart from "hard-coded to the
        // more obvious value", the same reasoning the file-level `stageConfigs` above gives for
        // picking `testing` as `backlog`'s own `onPass`.
        const readyStageConfigs = new StaticStageConfigStore(
            [
                'stages:',
                '  - name: implementing',
                '    mode: agent',
                '    model: claude-opus',
                '    instructions: build it',
                '    onPass: ready',
                '    onFail: implementing',
                '  - name: ready',
                '    mode: manual',
                '    model: claude-opus',
                '    instructions: human review',
                '    onPass: merged',
                '    onFail: testing',
                '  - name: testing',
                '    mode: agent',
                '    model: claude-opus',
                '    instructions: test the thing',
                '    onPass: merged',
                '    onFail: implementing',
                '',
            ].join('\n'),
        );

        const freshFindingsBoard = () => {
            const events = { append: vi.fn(async () => {}), outputTokensSince: vi.fn(async () => 0) };
            const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
            const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
            const logger = fakeLogger();
            const broker = { send: vi.fn(async () => 'job-1'), cancel: vi.fn(async () => {}), getJob: vi.fn(async () => null) };
            const cardJobs = new CardJobs(config, db, broker as unknown as JobBroker);
            const service = new BoardWriteService(
                board,
                config,
                { reclaim: vi.fn(async () => {}) } as unknown as WorktreeManager,
                events as unknown as EventLog,
                logger,
                cardJobs,
                broker as unknown as JobBroker,
                new RunningCards(),
                defaultSettings(),
                readyStageConfigs,
            );
            return { board, events, service };
        };

        const humanFinding = (
            overrides: Partial<{ file: string; line: number; severity: 'blocker' | 'concern' | undefined; problem: string; suggestion: string }> = {},
        ) => ({
            file: 'src/thing.ts',
            line: 12,
            severity: 'blocker' as const,
            problem: 'the thing is broken',
            suggestion: 'fix the thing',
            ...overrides,
        });

        it('answers a card that does not exist with a 404', async () => {
            const { service } = freshFindingsBoard();

            await expect(service.recordFindings('missing', { findings: [humanFinding()] })).rejects.toMatchObject({ statusCode: 404 });
        });

        it('refuses a card outside "ready" with a 400 naming its actual stage, writing nothing (AC4)', async () => {
            const { board, events, service } = freshFindingsBoard();
            await board.create(card('0200', { stage: 'implementing' }), 'seed');
            const versionBefore = await board.currentVersion('0200');

            await expect(service.recordFindings('0200', { findings: [humanFinding()] })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('it is in "implementing", not "ready"') },
            });
            expect(await board.currentVersion('0200')).toBe(versionBefore);
            expect(events.append).not.toHaveBeenCalled();
        });

        it('refuses an empty findings list with a 400, writing nothing (AC4)', async () => {
            const { board, events, service } = freshFindingsBoard();
            await board.create(card('0201', { stage: 'ready' }), 'seed');
            const versionBefore = await board.currentVersion('0201');

            await expect(service.recordFindings('0201', { findings: [] })).rejects.toMatchObject({
                statusCode: 400,
                details: { reason: expect.stringContaining('no comments were submitted') },
            });
            expect(await board.currentVersion('0201')).toBe(versionBefore);
            expect(events.append).not.toHaveBeenCalled();
        });

        it('writes exactly one card version and one transition.written event, by human, naming the count (AC1)', async () => {
            const { board, events, service } = freshFindingsBoard();
            await board.create(card('0202', { stage: 'ready' }), 'seed');
            const versionsBefore = await board.versions('0202', 10);

            await service.recordFindings('0202', {
                findings: [humanFinding({ file: 'a.ts', line: 1 }), humanFinding({ file: 'b.ts', line: 2 })],
            });

            const versionsAfter = await board.versions('0202', 10);
            expect(versionsAfter).toHaveLength(versionsBefore.length + 1);
            expect(events.append).toHaveBeenCalledTimes(1);
            expect(events.append).toHaveBeenCalledWith(
                expect.objectContaining({
                    cardId: '0202',
                    type: 'transition.written',
                    payload: expect.objectContaining({ from: 'ready', by: 'human', reason: expect.stringContaining('2') }),
                }),
                expect.anything(),
            );
        });

        it("moves the card to \"ready\"'s own configured onFail, not a hard-coded \"implementing\" (AC3)", async () => {
            const { board, service } = freshFindingsBoard();
            await board.create(card('0203', { stage: 'ready' }), 'seed');

            const detail = await service.recordFindings('0203', { findings: [humanFinding()] });

            expect(detail.stage).toBe('testing');
            const stored = await board.read('0203');
            expect(stored.frontmatter.stage).toBe('testing');
        });

        it('folds every comment into the body\'s "## Review findings" section, one bullet each, under a human-written note (AC2)', async () => {
            const { board, service } = freshFindingsBoard();
            await board.create(card('0204', { stage: 'ready' }, '## Goal\n\nDo the thing.'), 'seed');

            await service.recordFindings('0204', {
                findings: [
                    humanFinding({ file: 'a.ts', line: 1, severity: 'blocker', problem: 'p1', suggestion: 's1' }),
                    humanFinding({ file: 'b.ts', line: 2, severity: 'concern', problem: 'p2', suggestion: 's2' }),
                ],
            });

            const stored = await board.read('0204');
            expect(stored.body).toBe(
                '## Goal\n\nDo the thing.\n\n## Review findings\n' +
                    '_A human left these comments on the diff._\n\n' +
                    '- **blocker** `a.ts:1`: p1 — s1\n' +
                    '- **concern** `b.ts:2`: p2 — s2',
            );
        });

        it('defaults an omitted severity to "blocker"', async () => {
            const { board, service } = freshFindingsBoard();
            await board.create(card('0205', { stage: 'ready' }, '## Goal\n\nDo the thing.'), 'seed');

            await service.recordFindings('0205', { findings: [humanFinding({ severity: undefined })] });

            const stored = await board.read('0205');
            expect(stored.body).toContain('- **blocker**');
        });

        it('leaves retries untouched and needsHuman unset — this is a human review, not a runner kickback (AC5)', async () => {
            const { board, service } = freshFindingsBoard();
            await board.create(card('0206', { stage: 'ready', retries: { ready: 2 } }), 'seed');

            const detail = await service.recordFindings('0206', { findings: [humanFinding()] });

            expect(detail.needsHuman).toBe(false);
            const stored = await board.read('0206');
            expect(stored.frontmatter.retries).toEqual({ ready: 2 });
            expect(stored.frontmatter.needsHuman).toBe(false);
        });
    });
});
