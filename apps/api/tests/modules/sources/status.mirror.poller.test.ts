import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Logger } from '@maroonedsoftware/logger';
import { AppConfig } from '@maroonedsoftware/appconfig';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import type { CardSource, MirrorStatus } from '#modules/sources/card.source.js';
import { CardSourceRegistry } from '#modules/sources/card.source.registry.js';
import { SourceCursorRepository } from '#modules/sources/source.cursor.repository.js';
import { STATUS_MIRROR_CURSOR_KEY, StatusMirrorPoller } from '#modules/sources/status.mirror.poller.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

/**
 * Card 0201, the same idiom `source.poller.test.ts`'s own "end to end against a real board" section
 * uses (`testDb`, `uniqueProject`): the acceptance criteria here are about real `runner.card_events`
 * rows and a real cursor row, which a fake event log could only ever assert agrees with itself about.
 */
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const fakeLogger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() }) as unknown as Logger;

const card = (id: string, overrides: Partial<Card['frontmatter']> = {}): Card => ({
    frontmatter: { id, title: `card ${id}`, stage: 'parking-lot', dependsOn: [], retries: {}, ...overrides },
    sections: {},
    body: '## Goal\n\nDo it.\n',
});

/** Reach the private `tick()` directly — one project, one tick, deterministically, with no interval
 * or timer involved. The same idiom `source.poller.test.ts`'s `runOneTick` uses. */
const runTick = (poller: StatusMirrorPoller): Promise<void> => (poller as unknown as { tick: () => Promise<void> }).tick();

/**
 * A fresh project wired against a real `PostgresBoardRepository`/`EventLog` on the test db, and a
 * `StatusMirrorPoller` constructed the same way `SourcesModule` wires the real one (this class is a
 * plain, undecorated constructor — no DI container needed to build one directly).
 */
const setup = (sources: CardSource[] = []) => {
    const project = uniqueProject();
    const config = new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run');
    const events = new EventLog(db, fakeLogger());
    const board = new PostgresBoardRepository(config, db, events);
    const cursors = new SourceCursorRepository(config, db);
    const registry = new CardSourceRegistry(sources);
    const settings = new SettingsStore(config, db, new AppConfig({ STATUS_MIRROR_ENABLED: 'true' }));
    const logger = fakeLogger();
    const poller = new StatusMirrorPoller(registry, cursors, board, config, settings, db, logger);
    return { project, config, board, events, cursors, registry, settings, logger, poller };
};

/** Appends a real `transition.written` event for `cardId` and moves it to `to` — the two things
 * `BoardRepository.writeWithEvent` always does together, without pulling in `StageDispatcher` or
 * `BoardWriteService` just to produce one. */
const writeTransition = async (
    board: PostgresBoardRepository,
    config: StaticBoardConfig,
    cardId: string,
    stage: string,
    from: string,
    to: string,
    extraPayload: Record<string, unknown> = {},
): Promise<void> => {
    await board.writeWithEvent(
        cardId,
        `${cardId}: ${stage} -> ${to}`,
        current => ({ ...current, frontmatter: { ...current.frontmatter, stage: to } }),
        { project: config.project, cardId, stage, type: 'transition.written', payload: { from, to, by: 'runner', ...extraPayload } },
    );
};

/** A `CardSource` that records every `mirrorStatus` call it receives and always succeeds. */
const trackingSource = (name: string): { source: CardSource; calls: Array<{ externalId: string; status: MirrorStatus }> } => {
    const calls: Array<{ externalId: string; status: MirrorStatus }> = [];
    const source: CardSource = {
        name,
        changedSince: async () => ({ ok: true, items: [], cursor: '' }),
        mirrorStatus: async (externalId, status) => {
            calls.push({ externalId, status });
            return { ok: true };
        },
    };
    return { source, calls };
};

describe('StatusMirrorPoller — which transitions mirror', () => {
    it('mirrors the first genuine scope-check -> implementing pass, and not implementing -> testing or testing -> review after it', async () => {
        const { source, calls } = trackingSource('github');
        const { board, config, poller } = setup([source]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');

        await writeTransition(board, config, '0001', 'scope-check', 'scope-check', 'implementing');
        await writeTransition(board, config, '0001', 'implementing', 'implementing', 'testing');
        await writeTransition(board, config, '0001', 'testing', 'testing', 'review');

        await runTick(poller);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.status.moment).toBe('started');
        expect(calls[0]!.externalId).toBe('octocat/hello-world#1');
    });

    it('does not mirror a kickback landing back on implementing from testing or review', async () => {
        const { source, calls } = trackingSource('github');
        const { board, config, poller } = setup([source]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');

        await writeTransition(board, config, '0001', 'testing', 'testing', 'implementing');
        await writeTransition(board, config, '0001', 'review', 'review', 'implementing');

        await runTick(poller);

        expect(calls).toHaveLength(0);
    });

    it('mirrors a second scope-check -> implementing pass after a kickback-and-reapproval cycle', async () => {
        const { source, calls } = trackingSource('github');
        const { board, config, poller } = setup([source]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');

        await writeTransition(board, config, '0001', 'scope-check', 'scope-check', 'implementing');
        await writeTransition(board, config, '0001', 'review', 'review', 'implementing');
        await writeTransition(board, config, '0001', 'scope-check', 'scope-check', 'implementing');

        await runTick(poller);

        expect(calls).toHaveLength(2);
        expect(calls.every(c => c.status.moment === 'started')).toBe(true);
    });

    it.each(['ready', 'merged', 'dropped'] as const)('mirrors a transition reaching %s', async to => {
        const { source, calls } = trackingSource('github');
        const { board, config, poller } = setup([source]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');

        await writeTransition(board, config, '0001', 'review', 'review', to);

        await runTick(poller);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.status.moment).toBe(to);
    });

    it('mirrors a needsHuman transition regardless of its reason text, and never hands that raw reason to the source', async () => {
        const { source, calls } = trackingSource('github');
        const { board, config, poller } = setup([source]);
        const secretReason = 'over budget: spent $412.55 of $50.00 cap at /etc/secret-path.ts';
        await board.create(
            card('0001', { external: { github: 'octocat/hello-world#1' }, needsHuman: true, needsHumanReason: secretReason }),
            'create',
        );

        await writeTransition(board, config, '0001', 'implementing', 'implementing', 'implementing', { needsHuman: true });

        await runTick(poller);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.status.moment).toBe('needs-human');
        // The raw reason is available on `MirrorStatus` for a source that wants it structurally, but
        // this card's own `GitHubIssuesSource.mirrorStatus` never interpolates it into a comment body
        // (see that class's own test) — this only proves the poller does not withhold it out of an
        // overcautious guess, since the composed-sentence rule lives in the source, not here.
        expect(calls[0]!.status.reason).toBe(secretReason);
    });

    it('skips a card with no external ref, never looking it up against CardSourceRegistry', async () => {
        const { source, calls } = trackingSource('github');
        const { board, config, registry, poller } = setup([source]);
        const listSpy = vi.spyOn(registry, 'list');
        await board.create(card('0001'), 'create');

        await writeTransition(board, config, '0001', 'review', 'review', 'ready');

        await runTick(poller);

        expect(calls).toHaveLength(0);
        expect(listSpy).not.toHaveBeenCalled();
    });
});

describe('StatusMirrorPoller — cursor advancement', () => {
    it('advances the cursor past a source refusal, so the same event is not retried forever', async () => {
        const refusing: CardSource = {
            name: 'github',
            changedSince: async () => ({ ok: true, items: [], cursor: '' }),
            mirrorStatus: vi.fn(async () => ({ ok: false, reason: 'rate limited' })),
        };
        const { board, config, cursors, poller } = setup([refusing]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');
        await writeTransition(board, config, '0001', 'review', 'review', 'ready');

        await runTick(poller);
        const cursorAfterFirst = await cursors.get(STATUS_MIRROR_CURSOR_KEY);
        expect(cursorAfterFirst).toBeDefined();

        await runTick(poller);

        expect(refusing.mirrorStatus).toHaveBeenCalledTimes(1);
        expect(await cursors.get(STATUS_MIRROR_CURSOR_KEY)).toBe(cursorAfterFirst);
    });

    it('does not re-mirror an already-mirrored event on a later tick', async () => {
        const { source, calls } = trackingSource('github');
        const { board, config, poller } = setup([source]);
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');
        await writeTransition(board, config, '0001', 'scope-check', 'scope-check', 'implementing');

        await runTick(poller);
        await runTick(poller);

        expect(calls).toHaveLength(1);
    });

    it('a tick with STATUS_MIRROR_ENABLED false mirrors nothing and does not advance the cursor', async () => {
        const { source, calls } = trackingSource('github');
        const project = uniqueProject();
        const config = new StaticBoardConfig(project, '/tmp/code', '/tmp/wt', '/tmp/run');
        const events = new EventLog(db, fakeLogger());
        const board = new PostgresBoardRepository(config, db, events);
        const cursors = new SourceCursorRepository(config, db);
        const registry = new CardSourceRegistry([source]);
        const settings = new SettingsStore(config, db, new AppConfig({ STATUS_MIRROR_ENABLED: 'false' }));
        const poller = new StatusMirrorPoller(registry, cursors, board, config, settings, db, fakeLogger());
        await board.create(card('0001', { external: { github: 'octocat/hello-world#1' } }), 'create');
        await writeTransition(board, config, '0001', 'review', 'review', 'ready');

        await runTick(poller);

        expect(calls).toHaveLength(0);
        expect(await cursors.get(STATUS_MIRROR_CURSOR_KEY)).toBeUndefined();
    });
});
