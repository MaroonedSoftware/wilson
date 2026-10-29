import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Logger } from '@maroonedsoftware/logger';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { CacheIdempotencyStore, type IdempotencyStore } from '@maroonedsoftware/cache';
import { InboundCardWriter } from '#modules/sources/inbound.card.writer.js';
import type { CardSourceItem } from '#modules/sources/card.source.js';
import { PostgresCacheProvider } from '#modules/sources/postgres.cache.provider.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { CardJobs } from '#modules/jobs/card.jobs.js';
import { RunningCards } from '#modules/jobs/running.cards.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import type { SettingsStore } from '#modules/settings/settings.store.js';
import type { DB } from '#modules/data/db.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const fakeLogger = (): Logger =>
    ({
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
    }) as unknown as Logger;

/**
 * A fresh project + `InboundCardWriter`, wired against a real `PostgresBoardRepository` on the test
 * db and a real `BoardWriteService` — the same idiom `board.write.service.test.ts`'s own `freshBoard`
 * uses, unique per project so no test shares a board with another. Everything `BoardWriteService`
 * takes beyond `board`/`config`/`worktrees` is a double or a real lightweight collaborator: `apply`'s
 * two paths (`createFromSource`, then `rename`/`edit` on a second report) never reach the job queue,
 * the event log, or stage config, so those only need to satisfy the constructor, not do anything.
 * `worktrees` answers `hasWork` (which `rename` checks) `false` — a card fresh out of `createFromSource`
 * has no branch anything could have worked on yet.
 *
 * Card 0197: `idempotencyStore` defaults to a real `CacheIdempotencyStore` over a real
 * `PostgresCacheProvider` on the same test db, so the dedup tests below exercise the real claim/
 * duplicate/retention path rather than a fake's idea of it. A caller that wants to control exactly
 * what `deduplicate` reports back (the `dropped` test) passes its own fake instead.
 */
const freshWriter = (idempotencyStore?: IdempotencyStore, logger = fakeLogger(), notifyWebhookUrl?: string, notifyBaseUrl?: string) => {
    const events = { append: vi.fn(async () => {}) };
    const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run', notifyWebhookUrl, notifyBaseUrl);
    const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
    const worktrees = {
        branchName: vi.fn((cardId: string, title: string) => `card/${cardId}-${title}`),
        hasWork: vi.fn(async () => false),
        reclaim: vi.fn(async () => {}),
    };
    const broker = { send: vi.fn(async () => 'job-1'), cancel: vi.fn(async () => {}), getJob: vi.fn(async () => null) };
    const cardJobs = new CardJobs(config, db, broker as unknown as JobBroker);
    const boardWriteService = new BoardWriteService(
        board,
        config,
        worktrees as unknown as WorktreeManager,
        events as unknown as EventLog,
        fakeLogger(),
        cardJobs,
        broker as unknown as JobBroker,
        new RunningCards(),
        undefined as unknown as SettingsStore,
        new StaticStageConfigStore(),
    );
    const idempotency = idempotencyStore ?? new CacheIdempotencyStore(new PostgresCacheProvider(db));
    const writer = new InboundCardWriter(boardWriteService, board, idempotency, config, logger);
    return { board, config, writer, logger, boardWriteService };
};

const item = (overrides: Partial<CardSourceItem> = {}): CardSourceItem => ({
    externalId: 'ENG-1',
    title: 'Fix the thing',
    body: 'It is broken.',
    version: 'v1',
    closed: false,
    ...overrides,
});

describe('InboundCardWriter', () => {
    it('creates a card in parking-lot with the external ref recorded, on the first report', async () => {
        const { board, writer } = freshWriter();

        await writer.apply('linear', item());

        const cards = await board.list();
        expect(cards).toHaveLength(1);
        expect(cards[0]!.frontmatter.stage).toBe('parking-lot');
        expect(cards[0]!.frontmatter.title).toBe('Fix the thing');
        expect(cards[0]!.body).toBe('It is broken.');
        expect(cards[0]!.frontmatter.external).toEqual({ linear: 'ENG-1' });
    });

    it("updates the existing card's title and body on a second report carrying a changed version, gaining the board no second card", async () => {
        const { board, writer } = freshWriter();
        await writer.apply('linear', item());

        await writer.apply('linear', item({ version: 'v2', title: 'Fix the thing (updated)', body: 'Turns out it was worse.' }));

        const cards = await board.list();
        expect(cards).toHaveLength(1);
        expect(cards[0]!.frontmatter.title).toBe('Fix the thing (updated)');
        expect(cards[0]!.body).toBe('Turns out it was worse.');
        expect(cards[0]!.frontmatter.external).toEqual({ linear: 'ENG-1' });
    });

    it('does not confuse the same external id reported under two different sources', async () => {
        const { board, writer } = freshWriter();
        await writer.apply('linear', item({ externalId: 'SHARED-1', title: 'Linear title' }));

        await writer.apply('github', item({ externalId: 'SHARED-1', title: 'GitHub title' }));

        const cards = await board.list();
        expect(cards).toHaveLength(2);
        expect(cards.map(c => c.frontmatter.title).sort()).toEqual(['GitHub title', 'Linear title']);
        expect(cards.map(c => c.frontmatter.external)).toEqual(
            expect.arrayContaining([{ linear: 'SHARED-1' }, { github: 'SHARED-1' }]),
        );
    });

    it('leaves other cards alone and creates a new one when a report names an external id not yet on the board', async () => {
        const { board, writer } = freshWriter();
        await writer.apply('linear', item({ externalId: 'ENG-1', title: 'First' }));

        await writer.apply('linear', item({ externalId: 'ENG-2', title: 'Second' }));

        const cards = await board.list();
        expect(cards).toHaveLength(2);
        expect(cards.map(c => c.frontmatter.title).sort()).toEqual(['First', 'Second']);
    });

    it('exposes no way to set stage, branch, or retries: forcing them onto a reported item through an unsafe cast still leaves them untouched', async () => {
        const { board, writer } = freshWriter();
        // `CardSourceItem` carries only `externalId`, `title`, `body`, and `version` — this cast is the
        // only way to even attempt handing `apply` a `stage`/`branch`/`retries`, and it proves the
        // class reads none of them: nothing it writes to the board carries them, not merely that a
        // validator would have refused them.
        const smuggled = {
            externalId: 'ENG-1',
            title: 'Title',
            body: 'Body',
            version: 'v1',
            stage: 'merged',
            branch: 'evil-branch',
            retries: { implementing: 99 },
        } as unknown as CardSourceItem;

        await writer.apply('linear', smuggled);

        const [created] = await board.list();
        expect(created!.frontmatter.stage).toBe('parking-lot');
        expect(created!.frontmatter.branch).toBeUndefined();
        expect(created!.frontmatter.retries).toEqual({});
    });

    /**
     * The create path staying in `parking-lot` (covered above) only proves half of "a source may
     * never touch `stage`" — the update path goes through `rename`/`edit`, not `createFromSource`,
     * so it needs its own check. A card a human has since promoted out of `parking-lot` (the board's
     * own move, bypassing the writer entirely, the way an operator's drag would) must stay exactly
     * where the human put it when the same external ref is reported again — `apply`'s update branch
     * has no parameter that could carry a stage even if it wanted to.
     */
    it('does not move a card a human has since promoted, when the same external ref is reported again with a changed version', async () => {
        const { board, writer } = freshWriter();
        await writer.apply('linear', item({ externalId: 'ENG-1', title: 'First' }));
        const [created] = await board.list();
        await board.write(created!.frontmatter.id, 'operator promotes it by hand', card => ({
            ...card,
            frontmatter: { ...card.frontmatter, stage: 'implementing' },
        }));

        await writer.apply('linear', item({ externalId: 'ENG-1', version: 'v2', title: 'First (updated upstream)' }));

        const cards = await board.list();
        expect(cards).toHaveLength(1);
        expect(cards[0]!.frontmatter.stage).toBe('implementing');
        expect(cards[0]!.frontmatter.title).toBe('First (updated upstream)');
    });

    /**
     * Card 0197's whole reason to exist: [[0198]]'s poll reports the same unedited item again on
     * every later tick (`since` is inclusive), and a webhook redelivers at least once. Both land here
     * as the exact same `(source, externalId, version)` — the second `apply` must skip the board write
     * entirely, not merely happen to produce the same result.
     */
    it('performs no board write on a second report of the same version, whether the card was created or already existed', async () => {
        const { board, writer, boardWriteService } = freshWriter();

        await writer.apply('linear', item());
        const createSpy = vi.spyOn(boardWriteService, 'createFromSource');
        await writer.apply('linear', item());
        expect(createSpy).not.toHaveBeenCalled();

        await writer.apply('linear', item({ version: 'v2', title: 'Updated' }));
        const renameSpy = vi.spyOn(boardWriteService, 'rename');
        const editSpy = vi.spyOn(boardWriteService, 'edit');
        await writer.apply('linear', item({ version: 'v2', title: 'Updated' }));
        expect(renameSpy).not.toHaveBeenCalled();
        expect(editSpy).not.toHaveBeenCalled();

        expect(await board.list()).toHaveLength(1);
    });

    /**
     * `IdempotencyStore.deduplicate`'s three outcomes: `dropped` — `work` has failed `maxAttempts`
     * times for this key — must be logged (the way `SourcePoller` already logs a source refusal) and
     * must not throw, so the caller's walk over the rest of its own batch keeps going. A fake
     * `IdempotencyStore` reports `dropped` directly rather than driving a real `work` to fail
     * `maxAttempts` times for real, which is `CacheIdempotencyStore`'s own concern, not this class's.
     */
    it('logs a dropped outcome and does not throw, performing no board write', async () => {
        const dropped = { deduplicate: vi.fn(async () => ({ status: 'dropped' as const, attempts: 5 })) } as unknown as IdempotencyStore;
        const { board, writer, logger } = freshWriter(dropped);

        await expect(writer.apply('linear', item())).resolves.toBeUndefined();

        expect(await board.list()).toHaveLength(0);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('dropped'));
    });
});

/**
 * Card 0200: a closed item is not a create-or-update. `fetch` is stubbed rather than `Notifier`
 * itself, the same idiom `stage.dispatcher.test.ts` uses for the equivalent `needs-human`
 * notification — what is asserted is the observable HTTP call a real webhook would receive, while
 * the board write itself is real, against the same `PostgresBoardRepository` every other test in
 * this file uses.
 */
describe('InboundCardWriter — a closed item (card 0200)', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    /** A row in `wilson.cardJobs` is exactly what `BoardRepository.hasLiveClaim` treats as "a stage
     * is executing this card right now" (card 0128) — the same idiom
     * `postgres.board.repository.test.ts`'s own `hasLiveClaim` test uses to fake one without a real
     * job broker. */
    const claim = async (project: string, cardId: string) => {
        await db.insertInto('wilson.cardJobs').values({ project, cardId, jobId: 'job-1' }).execute();
    };

    it('does nothing for a closed item naming a ref the board has never seen', async () => {
        const { board, writer } = freshWriter(undefined, fakeLogger(), 'https://hooks.example/notify');

        await writer.apply('github', item({ closed: true }));

        expect(await board.list()).toHaveLength(0);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('moves a matching parking-lot card to dropped and notifies exactly once', async () => {
        const { board, writer, config } = freshWriter(undefined, fakeLogger(), 'https://hooks.example/notify', 'https://board.example');
        await writer.apply('github', item({ externalId: 'ENG-1' }));

        await writer.apply('github', item({ externalId: 'ENG-1', closed: true }));

        const [card] = await board.list();
        expect(card!.frontmatter.stage).toBe('dropped');
        expect(card!.frontmatter.sourceClosed).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
        expect(body).toMatchObject({ moment: 'source-closed', project: config.project, stage: 'dropped', url: 'https://board.example/cards/' + card!.frontmatter.id });
    });

    it('moves a matching planning or backlog card to dropped too, the same as parking-lot', async () => {
        const { board, writer } = freshWriter(undefined, fakeLogger(), 'https://hooks.example/notify');
        await writer.apply('github', item({ externalId: 'ENG-1' }));
        const [created] = await board.list();
        await board.write(created!.frontmatter.id, 'move to backlog', c => ({ ...c, frontmatter: { ...c.frontmatter, stage: 'backlog' } }));

        await writer.apply('github', item({ externalId: 'ENG-1', closed: true }));

        const [card] = await board.list();
        expect(card!.frontmatter.stage).toBe('dropped');
        expect(card!.frontmatter.sourceClosed).toBe(true);
    });

    it('flags a matching card at ready and notifies once, but leaves it at ready rather than dropping it', async () => {
        const { board, writer, config } = freshWriter(undefined, fakeLogger(), 'https://hooks.example/notify');
        await writer.apply('github', item({ externalId: 'ENG-1' }));
        const [created] = await board.list();
        await board.write(created!.frontmatter.id, 'promote to ready', c => ({ ...c, frontmatter: { ...c.frontmatter, stage: 'ready' } }));

        await writer.apply('github', item({ externalId: 'ENG-1', closed: true }));

        const [card] = await board.list();
        expect(card!.frontmatter.stage).toBe('ready');
        expect(card!.frontmatter.sourceClosed).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
        expect(body).toMatchObject({ moment: 'source-closed', project: config.project, stage: 'ready' });
    });

    it('sets sourceClosed and changes nothing else on a card something is actively running, and sends no notification yet', async () => {
        const { board, writer, config } = freshWriter(undefined, fakeLogger(), 'https://hooks.example/notify');
        await writer.apply('github', item({ externalId: 'ENG-1' }));
        const [created] = await board.list();
        await board.write(created!.frontmatter.id, 'move to implementing', c => ({ ...c, frontmatter: { ...c.frontmatter, stage: 'implementing' } }));
        await claim(config.project, created!.frontmatter.id);

        await writer.apply('github', item({ externalId: 'ENG-1', closed: true }));

        const [card] = await board.list();
        expect(card!.frontmatter.stage).toBe('implementing');
        expect(card!.frontmatter.sourceClosed).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    /**
     * The one-way door (this card's Constraints): once `sourceClosed` is recorded, a second closed
     * report for the same card writes nothing and notifies nothing — checked here across all three
     * branches by asserting a spy on the write methods and the notifier both see zero calls on the
     * second `apply`.
     */
    it('does nothing on a second closed report against a card already carrying sourceClosed: true, in every branch', async () => {
        const { board, writer, config } = freshWriter(undefined, fakeLogger(), 'https://hooks.example/notify');

        // Branch 1: parking-lot -> dropped.
        await writer.apply('github', item({ externalId: 'DROP-1' }));
        await writer.apply('github', item({ externalId: 'DROP-1', closed: true }));

        // Branch 2: ready, flagged in place.
        await writer.apply('github', item({ externalId: 'READY-1' }));
        const [readyCard] = (await board.list()).filter(c => c.frontmatter.external?.github === 'READY-1');
        await board.write(readyCard!.frontmatter.id, 'promote to ready', c => ({ ...c, frontmatter: { ...c.frontmatter, stage: 'ready' } }));
        await writer.apply('github', item({ externalId: 'READY-1', closed: true }));

        // Branch 3: mid-run, flagged with no stage change.
        await writer.apply('github', item({ externalId: 'RUN-1' }));
        const [runCard] = (await board.list()).filter(c => c.frontmatter.external?.github === 'RUN-1');
        await board.write(runCard!.frontmatter.id, 'move to implementing', c => ({ ...c, frontmatter: { ...c.frontmatter, stage: 'implementing' } }));
        await claim(config.project, runCard!.frontmatter.id);
        await writer.apply('github', item({ externalId: 'RUN-1', closed: true }));

        fetchMock.mockClear();
        const writeSpy = vi.spyOn(board, 'write');
        const writeWithEventSpy = vi.spyOn(board, 'writeWithEvent');

        await writer.apply('github', item({ externalId: 'DROP-1', closed: true }));
        await writer.apply('github', item({ externalId: 'READY-1', closed: true }));
        await writer.apply('github', item({ externalId: 'RUN-1', closed: true }));

        expect(writeSpy).not.toHaveBeenCalled();
        expect(writeWithEventSpy).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
