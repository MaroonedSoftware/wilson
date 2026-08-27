import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import type { SseResponse } from '@maroonedsoftware/koa';
import { PlanStreamRouter } from '#src/routes/routes.setup.js';
import { PlanTurnRepository } from '#modules/plan/plan.turn.repository.js';
import { planFeed } from '#modules/plan/plan.session.feed.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';

/**
 * Card 0133, task 3: `GET /api/cards/:id/plan/stream` replays a card's stored turns after the
 * client's `Last-Event-ID`, then subscribes to `planFeed` for the deltas of whatever turn is still
 * being written. This drives the real handler — pulled off the router the same structural way
 * `card.feed.route.test.ts` drives `openCardFeedStream`, since `openSseStream` is documented as
 * testable against a fake `ctx.res` sink without a real server — rather than re-testing
 * `PlanTurnRepository` (already covered on its own) or `planFeed` (ditto) in isolation.
 *
 * The handler needs exactly two things from `ctx.container` — `BoardConfig` and the shared
 * `Kysely<DB>` — so the fake container below resolves only those two tokens, matching what
 * `PlanStreamRouter`'s own doc comment says it builds `PlanTurnRepository` from.
 */
const fakeCtx = (
    id: string,
    config: StaticBoardConfig,
    db: Kysely<DB>,
    options: { lastEventId?: string; query?: Record<string, unknown> } = {},
): { ctx: Record<string, unknown>; frames: () => string[]; ended: () => boolean } => {
    const chunks: string[] = [];
    let ended = false;
    const res: SseResponse = {
        writeHead: () => undefined,
        write: (chunk: string) => {
            chunks.push(chunk);
            return true;
        },
        end: () => {
            ended = true;
        },
        destroy: () => undefined,
        setTimeout: () => undefined,
        on: () => undefined,
    };
    // The handler resolves exactly two tokens from the container: `Kysely<DB>` and `BoardConfig`.
    // `Kysely` is the one distinguishable-by-identity token here; anything else it asks for is the
    // `BoardConfig` this test built, mirroring what a real container would resolve.
    const container = { get: (token: unknown) => (token === Kysely ? db : config) };
    return {
        ctx: { status: 0, respond: true, res, params: { id }, headers: options.lastEventId ? { 'last-event-id': options.lastEventId } : {}, query: options.query ?? {}, container },
        frames: () => [...chunks],
        ended: () => ended,
    };
};

/** Pulls the raw `data:` line out of every frame of the given SSE `event:` name. A `turn` frame
 * carries an `id:` line ahead of `event:` (`stream.event({ id: turn.seq, ... })`); a `delta` frame
 * does not — so this matches on the `event:` line appearing anywhere in the frame, not just first. */
const dataLinesOf = (frames: string[], eventName: string): string[] =>
    frames
        .filter(frame => frame.split('\n').includes(`event: ${eventName}`))
        .map(frame => {
            const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
            if (!dataLine) throw new Error(`frame carried no data line: ${frame}`);
            return dataLine.slice('data: '.length);
        });

/** `turn` frames carry a `PlanTurn` object, JSON-encoded (`frameEvent` only leaves string data
 * un-stringified) — parsed back into an object here. */
const turnEventsOf = (frames: string[]): Array<Record<string, unknown>> =>
    dataLinesOf(frames, 'turn').map(line => JSON.parse(line) as Record<string, unknown>);

/** `delta` frames carry the raw assistant-text chunk as a plain string (`stream.event({ data:
 * event.message })`, and `event.message` is already a string) — `frameEvent` writes a string
 * `data` verbatim rather than JSON-encoding it, so this reads the line back as-is. */
const deltaMessagesOf = (frames: string[]): string[] => dataLinesOf(frames, 'delta');

const routeHandler = (): ((ctx: unknown, next: () => Promise<void>) => Promise<void>) => {
    const router = PlanStreamRouter();
    const layer = router.stack.find(l => l.path === '/api/cards/:id/plan/stream' && l.methods.includes('GET'));
    if (!layer) throw new Error('GET /api/cards/:id/plan/stream is not registered');
    const handler = layer.stack.at(-1);
    if (!handler) throw new Error('matched layer carries no handler');
    return handler as unknown as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
};

/** Builds the handler for a specific `PlanStreamRouter(signal)` instance rather than the
 * signal-less default `routeHandler()` above — needed for the shutdown-drains-the-stream tests. */
const routeHandlerFor = (signal: AbortSignal): ((ctx: unknown, next: () => Promise<void>) => Promise<void>) => {
    const router = PlanStreamRouter(signal);
    const layer = router.stack.find(l => l.path === '/api/cards/:id/plan/stream' && l.methods.includes('GET'));
    if (!layer) throw new Error('GET /api/cards/:id/plan/stream is not registered');
    const handler = layer.stack.at(-1);
    if (!handler) throw new Error('matched layer carries no handler');
    return handler as unknown as (ctx: unknown, next: () => Promise<void>) => Promise<void>;
};

const noop = async (): Promise<void> => {};

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

describe('GET /api/cards/:id/plan/stream', () => {
    it('replays every stored turn, in order, for a fresh connection with no Last-Event-ID', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        const planTurns = new PlanTurnRepository(config, db);
        await planTurns.append('0301', 'user', 'first');
        await planTurns.append('0301', 'assistant', 'first reply');
        await planTurns.append('0301', 'user', 'second');

        const { ctx, frames } = fakeCtx('0301', config, db);
        await routeHandler()(ctx, noop);

        const events = turnEventsOf(frames());
        expect(events.map(e => e.content)).toEqual(['first', 'first reply', 'second']);
        expect(events.map(e => e.seq)).toEqual([1, 2, 3]);
    });

    it('reconnecting with Last-Event-ID replays every turn after it and none at or before it', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        const planTurns = new PlanTurnRepository(config, db);
        await planTurns.append('0302', 'user', 'first');
        await planTurns.append('0302', 'assistant', 'first reply');
        await planTurns.append('0302', 'user', 'second');
        await planTurns.append('0302', 'assistant', 'second reply');

        const { ctx, frames } = fakeCtx('0302', config, db, { lastEventId: '2' });
        await routeHandler()(ctx, noop);

        const events = turnEventsOf(frames());
        expect(events.map(e => e.seq)).toEqual([3, 4]);
        expect(events.some(e => e.seq === 1 || e.seq === 2)).toBe(false);
    });

    it('replays nothing beyond the latest stored turn when Last-Event-ID is already current', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        const planTurns = new PlanTurnRepository(config, db);
        await planTurns.append('0303', 'user', 'only turn');

        const { ctx, frames } = fakeCtx('0303', config, db, { lastEventId: '1' });
        await routeHandler()(ctx, noop);

        expect(turnEventsOf(frames())).toEqual([]);
    });

    it('sends no replay for a card with no stored turns yet', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');

        const { ctx, frames } = fakeCtx('no-such-card', config, db);
        await routeHandler()(ctx, noop);

        expect(turnEventsOf(frames())).toEqual([]);
    });

    it('forwards a delta published on planFeed after connecting, on top of the replayed history', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        const planTurns = new PlanTurnRepository(config, db);
        await planTurns.append('0304', 'user', 'hi');

        const { ctx, frames } = fakeCtx('0304', config, db);
        await routeHandler()(ctx, noop);
        expect(turnEventsOf(frames())).toHaveLength(1);

        planFeed.status(config.project, '0304', 'partial reply chunk');

        expect(deltaMessagesOf(frames())).toEqual(['partial reply chunk']);
    });

    it('publishes each of several deltas for the same card as its own frame, not only a final combined one', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');

        const { ctx, frames } = fakeCtx('0309', config, db);
        await routeHandler()(ctx, noop);

        planFeed.status(config.project, '0309', 'chunk one');
        planFeed.status(config.project, '0309', 'chunk two');

        expect(deltaMessagesOf(frames())).toEqual(['chunk one', 'chunk two']);
    });

    it('does not forward a delta published for a different card id', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');

        const { ctx, frames } = fakeCtx('0305', config, db);
        await routeHandler()(ctx, noop);

        planFeed.status(config.project, 'some-other-card', 'not for this subscriber');

        expect(deltaMessagesOf(frames())).toEqual([]);
    });

    it('ends the stream when the given lifecycle signal aborts, instead of waiting to be force-closed', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        const controller = new AbortController();

        const { ctx, ended } = fakeCtx('0306', config, db);
        await routeHandlerFor(controller.signal)(ctx, noop);
        expect(ended()).toBe(false);

        controller.abort();

        expect(ended()).toBe(true);
    });

    it('releases its planFeed subscription when the lifecycle signal aborts, so a later delta for the same card is not delivered', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        const controller = new AbortController();

        const { ctx, frames } = fakeCtx('0307', config, db);
        await routeHandlerFor(controller.signal)(ctx, noop);

        controller.abort();
        planFeed.status(config.project, '0307', 'arrives after shutdown');

        expect(deltaMessagesOf(frames())).toEqual([]);
    });

    it('leaves the stream open with no end-of-life effect when no signal is given at all', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');

        const { ctx, ended } = fakeCtx('0308', config, db);
        await routeHandler()(ctx, noop);

        expect(ended()).toBe(false);
    });
});
