import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import { CardStageJob } from '#modules/jobs/card.stage.job.js';
import { RebaseConflictError } from '#modules/stages/stage.dispatcher.js';
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

// A real board in the test database, the same way stage.dispatcher.test.ts and
// stage.dispatcher.budget.test.ts exercise `writeWithEvent`: `flagRebaseConflict` (flag.rebase.conflict.ts)
// writes through it, and a mock standing in for it would only prove this test agrees with itself
// about what the write does, not that the card on disk actually ends up flagged, in place, with its
// retries untouched.
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
        title: 'a rebase-poisoned card',
        stage: 'testing',
        dependsOn: [],
        retries: {},
    },
    sections: {},
    body: '## Goal\n\nDo the thing.',
};

const conflict = new RebaseConflictError(
    'card/0001-a-rebase-poisoned-card',
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    'CONFLICT (content): Merge conflict in src/index.ts',
);

/**
 * Card 0103: a rebase conflict used to reach `CardStageJob` as a bare `Error`, fall through every
 * typed branch, retry three times under `CARD_STAGE_POLICY` (each attempt cutting a worktree and
 * running `pnpm install`), and dead-letter into `poisoned` — reclaiming the very worktree a human
 * needs to resolve the conflict by hand. `StageDispatcher.run` now throws the typed
 * `RebaseConflictError` instead, and this pins down that `CardStageJob` routes it to a flag, not a
 * retry: the card stays exactly where it was, keeps its retry count, and is never poisoned.
 */
describe('CardStageJob routes RebaseConflictError to a flag, not a retry (card 0103)', () => {
    let broker: { send: ReturnType<typeof vi.fn> };
    let events: { append: ReturnType<typeof vi.fn> };
    let cardJobs: { record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; inFlight: ReturnType<typeof vi.fn> };

    const buildJob = async (notifyWebhookUrl?: string, notifyBaseUrl?: string, card: Card = baseCard) => {
        const base = await mkdtemp(join(tmpdir(), 'card-stage-job-rebase-conflict-'));
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
                throw conflict;
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

    it('does not throw, so the queue does not retry a conflict that cannot succeed differently next time', async () => {
        const { job } = await buildJob();

        await expect(job.run({ cardId: '0001', stageName: 'testing' })).resolves.toBeUndefined();
    });

    it('does not poison the card', async () => {
        const { job } = await buildJob();

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(events.append.mock.calls.map(c => c[0].type)).not.toContain('stage.poisoned');
    });

    it('leaves the card in its current stage, flagged for a human, with its retries untouched', async () => {
        const { job, board } = await buildJob();

        await job.run({ cardId: '0001', stageName: 'testing' });

        const stored = await board.read('0001');
        expect(stored.frontmatter.stage).toBe('testing');
        expect(stored.frontmatter.needsHuman).toBe(true);
        expect(stored.frontmatter.retries).toEqual({});
    });

    it('names the conflict, the target commit and how to fix it in the flagged reason', async () => {
        const { job, board } = await buildJob();

        await job.run({ cardId: '0001', stageName: 'testing' });

        const stored = await board.read('0001');
        expect(stored.frontmatter.needsHumanReason).toContain('CONFLICT (content): Merge conflict in src/index.ts');
        expect(stored.frontmatter.needsHumanReason).toContain('deadbeef');
        expect(stored.frontmatter.needsHumanReason).toMatch(/rebase.*by hand/i);
        expect(stored.frontmatter.needsHumanReason).toContain('wilson card start');
    });

    it('records a rebase.conflict event carrying the branch, target commit and conflict detail', async () => {
        const { job } = await buildJob();

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(events.append).toHaveBeenCalledWith(
            expect.objectContaining({
                cardId: '0001',
                stage: 'testing',
                type: 'rebase.conflict',
                payload: {
                    branch: 'card/0001-a-rebase-poisoned-card',
                    targetSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
                    detail: 'CONFLICT (content): Merge conflict in src/index.ts',
                },
            }),
        );
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
            title: 'a rebase-poisoned card',
            stage: 'testing',
        });
        expect(body.reason).toContain('wilson card start');
    });

    it('makes no HTTP call when no webhook URL is configured', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { job } = await buildJob(undefined);

        await job.run({ cardId: '0001', stageName: 'testing' });

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not re-notify a card that was already flagged before this conflict was noticed', async () => {
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
