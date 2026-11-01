import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { CardStageJob } from '#modules/jobs/card.stage.job.js';
import { CONTEXT_OVERFLOW_REASON } from '#modules/stages/permanent.failure.js';
import { PostgresBoardRepository } from '#modules/board/postgres.board.repository.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { StaticStageConfigStore } from '#modules/stages/stage.config.store.js';
import type { BoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { EventLog } from '#modules/events/event.log.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import type { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import type { Card } from '#modules/board/card.js';
import type { Kysely } from 'kysely';
import type { DB } from '#modules/data/db.js';
import { defaultSettings } from '#tests/support/fake.settings.js';

// A real board in the test database, the same way card.stage.job.rebase-conflict.test.ts exercises
// `writeWithEvent`: `flagContextOverflow` writes through it, and a mock standing in for it would only
// prove this test agrees with itself about what the write does, not that the card on disk actually
// ends up flagged, in place, with its retries untouched.
let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

const baseCard: Card = {
    frontmatter: {
        id: '0001',
        title: 'an overflowing card',
        stage: 'testing',
        dependsOn: [],
        retries: {},
    },
    sections: {},
    body: '## Goal\n\nDo the thing.',
};

// The provider's own shape for a prompt that no longer fits the model's context window — the exact
// text `isContextOverflow` (permanent.failure.ts) is written to recognise ahead of the broader
// `invalid_request_error` pattern that used to poison it.
const overflow = new Error(
    '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 220000 tokens > 200000 maximum"}}',
);

/**
 * Card 0072: a stage whose prompt overflows the model's context window used to reach
 * `CardStageJob` as a bare `invalid_request_error`, fall through to `isPermanentFailure`, and
 * poison the card — terminal, even though nothing about the deployment is broken, only this
 * attempt's turn was too big. `classifyDispatchFailure` now recognises the overflow ahead of
 * `isPermanentFailure` and routes it here: this pins that `CardStageJob` flags the card for a human
 * instead, the same "one attempt, then flag" shape card 0103 gave a rebase conflict.
 */
describe('CardStageJob routes a context-window overflow to a flag, not a poisoning (card 0072)', () => {
    let broker: { send: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let cardJobs: { record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; inFlight: ReturnType<typeof vi.fn> };

    const buildJob = async (notifyWebhookUrl?: string, notifyBaseUrl?: string, card: Card = baseCard) => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-context-overflow-'));
        const stageConfigs = new StaticStageConfigStore(`
stages:
  - name: testing
    mode: agent
    model: claude-opus
    instructions: test it
    onPass: review
    onFail: implementing
`);

        const config = new StaticBoardConfig(
            uniqueProject(),
            join(base, 'code'),
            join(base, 'worktrees'),
            join(base, 'run'),
            notifyWebhookUrl,
            notifyBaseUrl,
        );
        const board = new PostgresBoardRepository(config, db, events as unknown as EventLog);
        await board.create(card, 'initial');

        const dispatcher = {
            run: vi.fn(async () => {
                throw overflow;
            }),
        };

        const job = new CardStageJob(
            dispatcher as unknown as StageDispatcher,
            broker as unknown as JobBroker,
            config as BoardConfig,
            board as unknown as BoardRepository,
            events as unknown as EventLog,
            cardJobs as unknown as CardJobs,
            stageConfigs,
            defaultSettings,
        );

        return { job, board, config };
    };

    beforeEach(() => {
        broker = { send: vi.fn(async () => 'job-1') };
        events = { append: vi.fn(async () => {}) };
        cardJobs = { record: vi.fn(async () => {}), clear: vi.fn(async () => {}), inFlight: vi.fn(async () => undefined) };
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('does not throw, so the queue does not retry a stage that will build the same oversized prompt again', async () => {
        const { job } = await buildJob();

        await expect(job.run({ cardId: '0001', stageName: 'testing' })).resolves.toBeUndefined();
    });

    it('does not poison the card', async () => {
        const { job } = await buildJob();

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('stage.poisoned');
    });

    it('does not dead-letter the card', async () => {
        const { job } = await buildJob();

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('stage.dead');
    });

    it('leaves the card in its current stage, flagged for a human, with its retries untouched', async () => {
        const { job, board } = await buildJob();

        await job.run({ cardId: '0001', stageName: 'testing' });

        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('testing');
        expect(stored.frontmatter.needsHuman).toBe(true);
        expect(stored.frontmatter.retries).toEqual({});
    });

    it('names the context window, not the request, in the flagged reason', async () => {
        const { job, board } = await buildJob();

        await job.run({ cardId: '0001', stageName: 'testing' });

        const stored = await board.read('0001');
        expect(stored.frontmatter.needsHumanReason).toBe(CONTEXT_OVERFLOW_REASON);
        expect(stored.frontmatter.needsHumanReason).not.toContain('invalid_request_error');
    });

    it('records a context.overflow event carrying the reason, distinguishable from a poisoning', async () => {
        const { job } = await buildJob();

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'context.overflow',
                payload: { reason: CONTEXT_OVERFLOW_REASON },
            }),
        );
        expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('stage.poisoned');
    });

    it('writes the flag as a single new version, the move and the record committing together', async () => {
        const { job, board } = await buildJob();

        await job.run({ cardId: '0001', stageName: 'testing' });

        const history = await board.versions('0001', 10);
        expect(history).toHaveLength(2); // card creation, then this one flag

        const latest = await board.readAt('0001', history[0]!.id);
        expect(latest.frontmatter.stage).toBe('testing');
        expect(latest.frontmatter.needsHuman).toBe(true);
    });

    it('releases the claim and enqueues nothing, so the card is not left claiming a job that never ran again', async () => {
        const { job } = await buildJob();

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(cardJobs.clear).toHaveBeenCalledWith('0001');
        expect(cardJobs.record).not.toHaveBeenCalled();
        expect(broker.send).not.toHaveBeenCalled();
    });

    it('posts a "needs-human" notification naming the reason', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const { job } = await buildJob('https://hooks.example/notify', 'https://board.example');

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
        expect(body).toMatchObject({
            moment: 'needs-human',
            cardId: '0001',
            title: 'an overflowing card',
            stage: 'testing',
            reason: CONTEXT_OVERFLOW_REASON,
        });
    });

    it('makes no HTTP call when no webhook URL is configured', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { job } = await buildJob(undefined);

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not re-notify a card that was already flagged before this overflow was noticed', async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        const alreadyFlagged: Card = {
            ...baseCard,
            frontmatter: { ...baseCard.frontmatter, needsHuman: true, needsHumanReason: 'already flagged for something else' },
        };
        const { job } = await buildJob('https://hooks.example/notify', undefined, alreadyFlagged);

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(fetchMock).not.toHaveBeenCalled();
    });
});
