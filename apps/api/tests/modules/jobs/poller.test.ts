import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import type { BoardRepository } from '#modules/board/board.repository.js';
import type { Card, CardFrontmatter } from '#modules/board/card.js';
import type { CardJobs } from '#modules/jobs/card.jobs.js';
import type { JobBroker } from '@maroonedsoftware/jobbroker';
import type { Logger } from '@maroonedsoftware/logger';

/**
 * Card 0049. `Poller.loop` waits on `node:timers/promises`' `setTimeout` (aliased `delay` in
 * poller.ts) between ticks, with the running `AbortSignal` passed through so `stop()` can cancel a
 * wait in progress. Real `node:timers/promises` `setTimeout` is not intercepted by
 * `vi.useFakeTimers()` (see `shutdown.faketimer.test.ts`), so — exactly as that file does — the
 * module itself is mocked here with a version this suite drives by hand: each call returns a promise
 * that stays pending until the test releases it, or rejects the moment its signal aborts, mirroring
 * the real function's own abort behaviour. This lets the `start`/`stop`/interval-loop tests below
 * control exactly when a tick fires without waiting out (or faking) the real 30s production
 * interval, and without needing to know `POLLER_INTERVAL_MS`'s value at all.
 */
interface PendingDelay {
    resolve: () => void;
}
let pending: PendingDelay[] = [];

const delayMock = vi.fn((_ms: number, _value: undefined, opts: { signal: AbortSignal }) => {
    return new Promise<void>((resolve, reject) => {
        const entry: PendingDelay = {
            resolve: () => {
                opts.signal.removeEventListener('abort', onAbort);
                pending = pending.filter(p => p !== entry);
                resolve();
            },
        };
        const onAbort = () => {
            pending = pending.filter(p => p !== entry);
            reject(new Error('AbortError'));
        };
        if (opts.signal.aborted) {
            onAbort();
            return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
        pending.push(entry);
    });
});
vi.mock('node:timers/promises', () => ({ setTimeout: delayMock }));

const { Poller } = await import('#modules/jobs/poller.js');
const { POLLER_INTERVAL_MS } = await import('#modules/jobs/job.runner.config.js');

/** Release the oldest outstanding interval wait, letting the loop run one more tick. */
const releaseTick = () => pending.shift()?.resolve();

// A minimal but valid stages.yaml: `implementing` is an agent stage (dispatchable), `review` is
// manual (never dispatched). `loadStages` reads this from disk for real — it is not mocked — so
// `whyNotDispatchable`'s stage lookup inside `Poller.tick` is exercised exactly as it runs in
// production.
const stagesYaml = `
stages:
  - name: implementing
    mode: agent
    model: claude-opus
    instructions: implement it
    onPass: review
    onFail: implementing
  - name: review
    mode: manual
    model: claude-opus
    instructions: review it
    onPass: merged
    onFail: implementing
`;

let boardRoot: string;
beforeEach(async () => {
    boardRoot = await mkdtemp(join(tmpdir(), 'poller-test-'));
    await mkdir(join(boardRoot, 'config'), { recursive: true });
    await writeFile(join(boardRoot, 'config', 'stages.yaml'), stagesYaml);
    pending = [];
    delayMock.mockClear();
});
afterEach(async () => {
    await rm(boardRoot, { recursive: true, force: true });
});

const card = (id: string, stage: string, overrides: Partial<CardFrontmatter> = {}): Card => ({
    frontmatter: { id, title: `card ${id}`, stage, dependsOn: [], retries: {}, ...overrides } as CardFrontmatter,
    sections: {},
    body: '',
});

/** A `CardJobs` fake that actually remembers claims, so `inFlight` reflects a prior `record` the way the real one does. */
type FakeCardJobs = { inFlight: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
const statefulCardJobs = (initial: Record<string, string> = {}): FakeCardJobs => {
    const claims = new Map(Object.entries(initial));
    return {
        inFlight: vi.fn(async (cardId: string) => claims.get(cardId)),
        record: vi.fn(async (cardId: string, jobId: string) => {
            claims.set(cardId, jobId);
        }),
        clear: vi.fn(async (cardId: string) => {
            claims.delete(cardId);
        }),
    };
};

const fakeBroker = (jobId = 'job-1') => ({ send: vi.fn(async () => jobId) });
const fakeLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

const buildPoller = (
    cards: Card[],
    deps: Partial<{ cardJobs: FakeCardJobs; broker: ReturnType<typeof fakeBroker>; logger: ReturnType<typeof fakeLogger> }> = {},
) => {
    const config = new StaticBoardConfig('poller-test-project', boardRoot, '/tmp/code', '/tmp/wt', '/tmp/run');
    const board = { list: vi.fn(async () => cards) };
    const cardJobs = deps.cardJobs ?? statefulCardJobs();
    const broker = deps.broker ?? fakeBroker();
    const logger = deps.logger ?? fakeLogger();
    const poller = new Poller(
        board as unknown as BoardRepository,
        config,
        broker as unknown as JobBroker,
        cardJobs as unknown as CardJobs,
        logger as unknown as Logger,
    );
    return { poller, board, cardJobs, broker, logger };
};

/** Reach the private `tick()` directly: one tick, deterministically, with no interval/timer involved at all. */
const runOneTick = (poller: InstanceType<typeof Poller>): Promise<void> => (poller as unknown as { tick: () => Promise<void> }).tick();

describe('POLLER_INTERVAL_MS', () => {
    it('is 30 seconds', () => {
        expect(POLLER_INTERVAL_MS).toBe(30_000);
    });
});

describe('Poller tick — what it will and will not enqueue', () => {
    it('enqueues the one dispatchable card, sending to the broker before recording the claim', async () => {
        const { poller, broker, cardJobs, logger } = buildPoller([card('0001', 'implementing')]);

        await runOneTick(poller);

        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'implementing' });
        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'job-1');
        expect(broker.send.mock.invocationCallOrder[0]).toBeLessThan(cardJobs.record.mock.invocationCallOrder[0]);
        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(logger.info.mock.calls[0][0]).toContain('0001');
    });

    /**
     * The single most important check this card adds: a card something is already carrying must
     * never be enqueued a second time, or two agents end up on the same branch.
     */
    it('does not enqueue a card that already holds a live claim (CardJobs.inFlight)', async () => {
        const cardJobs = statefulCardJobs({ '0001': 'already-running-job' });
        const { poller, broker } = buildPoller([card('0001', 'implementing')], { cardJobs });

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
        expect(cardJobs.record).not.toHaveBeenCalled();
    });

    it('never enqueues a terminal card', async () => {
        for (const stage of ['merged', 'poisoned', 'dropped']) {
            const { poller, broker } = buildPoller([card('0001', stage)]);
            await runOneTick(poller);
            expect(broker.send).not.toHaveBeenCalled();
        }
    });

    it('never enqueues a parked card', async () => {
        const { poller, broker } = buildPoller([card('0001', 'parking-lot')]);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
    });

    it('never enqueues a card flagged for a human', async () => {
        const { poller, broker } = buildPoller([card('0001', 'implementing', { needsHuman: true })]);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
    });

    it('never enqueues a manual-mode stage', async () => {
        const { poller, broker } = buildPoller([card('0001', 'review')]);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
    });

    it('never enqueues a card whose dependency has not merged', async () => {
        const { poller, broker } = buildPoller([card('0001', 'implementing', { dependsOn: ['0099'] })]);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
    });

    it('takes at most one card per tick — the lowest id, even with several ready candidates', async () => {
        const cards = [card('0003', 'implementing'), card('0001', 'implementing'), card('0002', 'implementing')];
        const { poller, broker } = buildPoller(cards);

        await runOneTick(poller);

        expect(broker.send).toHaveBeenCalledTimes(1);
        expect(broker.send).toHaveBeenCalledWith('card.stage', { cardId: '0001', stageName: 'implementing' });
    });

    it('a tick that finds nothing dispatchable performs no write and logs nothing at info', async () => {
        const cards = [card('0001', 'merged'), card('0002', 'review'), card('0003', 'implementing', { needsHuman: true })];
        const { poller, broker, cardJobs, logger } = buildPoller(cards);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
        expect(cardJobs.record).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
    });

    it('an empty board performs no write and logs nothing at info', async () => {
        const { poller, broker, logger } = buildPoller([]);

        await runOneTick(poller);

        expect(broker.send).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
    });

    it('logs and swallows a failure instead of throwing, so one bad tick does not kill the loop', async () => {
        const config = new StaticBoardConfig('poller-test-project', boardRoot, '/tmp/code', '/tmp/wt', '/tmp/run');
        const boom = new Error('database is on fire');
        const board = { list: vi.fn(async () => Promise.reject(boom)) };
        const logger = fakeLogger();
        const poller = new Poller(
            board as unknown as BoardRepository,
            config,
            fakeBroker() as unknown as JobBroker,
            statefulCardJobs() as unknown as CardJobs,
            logger as unknown as Logger,
        );

        await expect(runOneTick(poller)).resolves.toBeUndefined();

        expect(logger.error).toHaveBeenCalledWith(boom);
    });
});

describe('Poller start/stop', () => {
    afterEach(async () => {
        // Belt and braces: abort anything a test left running so it cannot bleed into the next one.
        for (const entry of [...pending]) entry.resolve();
    });

    it('start() is idempotent: a second call while already running does not start a second loop', async () => {
        const { poller } = buildPoller([]);

        poller.start();
        poller.start();

        // Exactly one loop means exactly one outstanding interval wait, not two.
        expect(pending).toHaveLength(1);

        await poller.stop();
    });

    it('stop() is safe to call when the poller was never started', async () => {
        const { poller } = buildPoller([]);

        await expect(poller.stop()).resolves.toBeUndefined();
    });

    it('ticks through the real public start()/stop() surface once the interval elapses, using POLLER_INTERVAL_MS', async () => {
        const { poller, broker, cardJobs } = buildPoller([card('0001', 'implementing')]);

        poller.start();
        expect(delayMock).toHaveBeenCalledWith(POLLER_INTERVAL_MS, undefined, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        releaseTick();

        await vi.waitFor(() => expect(broker.send).toHaveBeenCalledTimes(1));
        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'job-1');

        await poller.stop();
    });

    /**
     * The property `jobs.module.ts`'s shutdown ordering depends on: once `stop()` resolves, nothing
     * is still mid-enqueue behind it. Proven here by holding a tick open on a `board.list()` that
     * will not resolve until the test says so, and showing `stop()`'s promise cannot have completed
     * before that — not by timing, but because it is causally blocked on the same promise chain.
     */
    it('stop() waits out a tick already in flight rather than abandoning it mid-enqueue', async () => {
        let releaseList: (() => void) | undefined;
        const cards = [card('0001', 'implementing')];
        const board = {
            list: vi.fn(
                () =>
                    new Promise<Card[]>(resolve => {
                        releaseList = () => resolve(cards);
                    }),
            ),
        };
        const cardJobs = statefulCardJobs();
        const broker = fakeBroker();
        const config = new StaticBoardConfig('poller-test-project', boardRoot, '/tmp/code', '/tmp/wt', '/tmp/run');
        const poller = new Poller(
            board as unknown as BoardRepository,
            config,
            broker as unknown as JobBroker,
            cardJobs as unknown as CardJobs,
            fakeLogger() as unknown as Logger,
        );

        poller.start();
        releaseTick();
        await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(1));

        const stopPromise = poller.stop();
        // The in-flight tick is still blocked inside board.list(), so it cannot have reached the
        // broker yet — this is a causal guarantee, not a timing assumption.
        expect(broker.send).not.toHaveBeenCalled();

        releaseList!();
        await stopPromise;

        expect(broker.send).toHaveBeenCalledTimes(1);
        expect(cardJobs.record).toHaveBeenCalledWith('0001', 'job-1');
    });

    it('a subsequent start() after stop() begins ticking again rather than staying blocked forever', async () => {
        const { poller, board } = buildPoller([card('0001', 'implementing')]);

        poller.start();
        releaseTick();
        await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(1));
        await poller.stop();

        poller.start();
        expect(pending).toHaveLength(1);
        releaseTick();
        await vi.waitFor(() => expect(board.list).toHaveBeenCalledTimes(2));

        await poller.stop();
    });
});
