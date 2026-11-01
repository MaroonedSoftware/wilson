import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely } from 'kysely';
import type { SseResponse } from '@maroonedsoftware/koa';
import { PlanStreamRouter } from '#src/routes/routes.setup.js';
import { BoardConfig, StaticBoardConfig } from '#modules/board/board.config.js';
import { PlanTurnRepository } from '#modules/plan/plan.turn.repository.js';
import { planFeed } from '#modules/plan/plan.session.feed.js';
import { testDb, uniqueProject } from '#tests/support/test.db.js';
import type { DB } from '#modules/data/db.js';
import { authorize } from '#tests/support/test.authorized.js';

let db: Kysely<DB>;
beforeAll(() => {
    db = testDb();
});
afterAll(async () => {
    await db.destroy();
});

/**
 * A fake SSE socket, following `card.feed.route.test.ts`'s own pattern: `openSseStream` takes over
 * `ctx.res` directly and writes frames to it, so a bare `write`/`end` sink drives the real transport
 * without a listening server.
 */
const fakeRes = (): { res: SseResponse; frames: () => string[]; ended: () => boolean } => {
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
    return { res, frames: () => [...chunks], ended: () => ended };
};

/**
 * One parsed SSE frame. `frameEvent` (the transport's own formatter) sends a string `data` verbatim
 * and JSON-encodes anything else — `PlanStreamRouter` sends a `turn` event's `data` as the stored
 * row (JSON-encoded) and a `delta` event's `data` as the plain chunk string (verbatim) — so parsing
 * has to keep the raw `data:` text rather than assume every frame is JSON.
 */
const parseFrames = (frames: string[]): Array<{ event?: string; id?: string; rawData: string }> =>
    frames.map(frame => {
        const lines = frame.split('\n').filter(line => line.length > 0);
        const eventLine = lines.find(line => line.startsWith('event: '));
        const idLine = lines.find(line => line.startsWith('id: '));
        const dataLines = lines.filter(line => line.startsWith('data: ')).map(line => line.slice('data: '.length));
        return { event: eventLine?.slice('event: '.length), id: idLine?.slice('id: '.length), rawData: dataLines.join('\n') };
    });

const turnFrames = (frames: string[]): Array<{ seq: number; role: string; content: string }> =>
    parseFrames(frames)
        .filter(f => f.event === 'turn')
        .map(f => JSON.parse(f.rawData) as { seq: number; role: string; content: string });

const deltaFrames = (frames: string[]): string[] =>
    parseFrames(frames)
        .filter(f => f.event === 'delta')
        .map(f => f.rawData);

/**
 * Drives `PlanStreamRouter`'s registered handler through `@koa/router`'s own public `routes()`
 * middleware — the documented dispatch entry point, not a private internal — with the smallest ctx
 * that satisfies both the router's own matching (`method`, `path`, a mutable `request`/`params`) and
 * the handler's own reads (`params`, `headers`, `query`, `container`, plus the structural SSE
 * `SseContext`: `status`, `respond`, `res`).
 */
const dispatch = async (
    router: ReturnType<typeof PlanStreamRouter>,
    opts: {
        path: string;
        headers?: Record<string, string>;
        query?: Record<string, unknown>;
        container: { get: (token: unknown) => unknown };
    },
): Promise<{ frames: () => string[]; ended: () => boolean }> => {
    const { res, frames, ended } = fakeRes();
    const ctx = {
        method: 'GET',
        path: opts.path,
        request: {},
        params: {},
        headers: opts.headers ?? {},
        query: opts.query ?? {},
        container: opts.container,
        status: 0,
        respond: true,
        res,
    };
    await router.routes()(authorize(ctx) as never, async () => {});
    return { frames, ended };
};

/** A container double resolving exactly the two tokens the handler asks for. */
const containerFor = (config: BoardConfig): { get: (token: unknown) => unknown } => ({
    get: (token: unknown) => {
        if (token === BoardConfig) return config;
        if (token === Kysely) return db;
        throw new Error(`unexpected container.get(${String(token)})`);
    },
});

describe('PlanStreamRouter', () => {
    it('replays every stored turn, in order, for a fresh client (no Last-Event-ID)', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const repo = new PlanTurnRepository(config, db);
        const id = randomUUID();
        await repo.append(id, 'user', 'first');
        await repo.append(id, 'assistant', 'first reply');
        await repo.append(id, 'user', 'second');

        const router = PlanStreamRouter();
        const { frames } = await dispatch(router, { path: `/api/cards/${id}/plan/stream`, container: containerFor(config) });

        const turns = turnFrames(frames());
        expect(turns.map(t => t.seq)).toEqual([1, 2, 3]);
        expect(turns.map(t => t.role)).toEqual(['user', 'assistant', 'user']);
        expect(turns.map(t => t.content)).toEqual(['first', 'first reply', 'second']);
    });

    it('sends nothing to replay for a card with no stored turns', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const id = randomUUID();

        const router = PlanStreamRouter();
        const { frames } = await dispatch(router, { path: `/api/cards/${id}/plan/stream`, container: containerFor(config) });

        expect(turnFrames(frames())).toHaveLength(0);
    });

    /**
     * Acceptance criteria: "A client reconnecting with `Last-Event-ID: <seq>` receives every turn
     * after `<seq>` and no turn at or before it."
     */
    it('replays only the turns after the given Last-Event-ID header, excluding the turn at that seq', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const repo = new PlanTurnRepository(config, db);
        const id = randomUUID();
        await repo.append(id, 'user', 'one');
        await repo.append(id, 'assistant', 'two');
        await repo.append(id, 'user', 'three');

        const router = PlanStreamRouter();
        const { frames } = await dispatch(router, {
            path: `/api/cards/${id}/plan/stream`,
            headers: { 'last-event-id': '1' },
            container: containerFor(config),
        });

        const turns = turnFrames(frames());
        expect(turns.map(t => t.seq)).toEqual([2, 3]);
        expect(turns.some(t => t.seq === 1)).toBe(false);
    });

    /**
     * Review finding on `routes.setup.ts:75`: a replayed row was sent to the wire straight from
     * `PlanTurnRepository.since` with no field selection, leaking `engineSessionId` — the Claude
     * Agent SDK's internal engine session id — the same class of bug already fixed for
     * `POST .../plan/turn` via `PlanService.toGeneratedTurn`, but not yet applied here. Asserts on
     * the raw parsed JSON rather than a typed subset, since a type ascription would hide an extra
     * field a real client would still receive.
     */
    it("never leaks a stored turn's engineSessionId over the wire when replaying", async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const repo = new PlanTurnRepository(config, db);
        const id = randomUUID();
        await repo.append(id, 'user', 'hello');
        await repo.append(id, 'assistant', 'hi there', 'top-secret-engine-session-id');

        const router = PlanStreamRouter();
        const { frames } = await dispatch(router, { path: `/api/cards/${id}/plan/stream`, container: containerFor(config) });

        const rawTurns = parseFrames(frames())
            .filter(f => f.event === 'turn')
            .map(f => JSON.parse(f.rawData) as Record<string, unknown>);
        expect(rawTurns).toHaveLength(2);
        for (const turn of rawTurns) {
            expect(turn).not.toHaveProperty('engineSessionId');
            expect(Object.keys(turn).sort()).toEqual(['content', 'createdAt', 'role', 'seq']);
        }
        expect(JSON.stringify(rawTurns)).not.toContain('top-secret-engine-session-id');
    });

    it('falls back to a ?lastEventId= query parameter when no header is given', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const repo = new PlanTurnRepository(config, db);
        const id = randomUUID();
        await repo.append(id, 'user', 'one');
        await repo.append(id, 'assistant', 'two');

        const router = PlanStreamRouter();
        const { frames } = await dispatch(router, {
            path: `/api/cards/${id}/plan/stream`,
            query: { lastEventId: '1' },
            container: containerFor(config),
        });

        expect(turnFrames(frames()).map(t => t.seq)).toEqual([2]);
    });

    /**
     * Acceptance criteria: "emits assistant text as it is produced, not only once the turn
     * completes" — a live delta published on `planFeed` after the client connects is forwarded
     * immediately, on top of whatever was replayed.
     */
    it('forwards a live assistant delta published after connecting, on top of the replayed turns', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const repo = new PlanTurnRepository(config, db);
        const id = randomUUID();
        await repo.append(id, 'user', 'hello');

        const router = PlanStreamRouter();
        const { frames } = await dispatch(router, { path: `/api/cards/${id}/plan/stream`, container: containerFor(config) });
        expect(turnFrames(frames())).toHaveLength(1);
        expect(deltaFrames(frames())).toHaveLength(0);

        planFeed.status(config.project, id, 'Hel');
        planFeed.status(config.project, id, 'lo');

        expect(deltaFrames(frames())).toEqual(['Hel', 'lo']);
    });

    it('never forwards a delta published for a different card', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const id = randomUUID();
        const otherId = randomUUID();

        const router = PlanStreamRouter();
        const { frames } = await dispatch(router, { path: `/api/cards/${id}/plan/stream`, container: containerFor(config) });

        planFeed.status(config.project, otherId, 'not for you');

        expect(deltaFrames(frames())).toHaveLength(0);
    });

    /**
     * Card 0150's own acceptance criterion: "Two registered projects' cards sharing an id are never
     * confused for one another across the API." Two projects can mint the same card id independently
     * — this is the case `correlationId` alone cannot distinguish, which is why `PlanStreamRouter` now
     * also filters `planFeed.onEvent` by `source: board.project` (`routes.setup.ts`).
     */
    it('never forwards a delta published for the same card id but a different, registered project', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const otherConfig = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const id = randomUUID();

        const router = PlanStreamRouter();
        const { frames } = await dispatch(router, { path: `/api/cards/${id}/plan/stream`, container: containerFor(config) });

        planFeed.status(otherConfig.project, id, 'meant for the other project, same card id');

        expect(deltaFrames(frames())).toHaveLength(0);
    });

    /**
     * Card 0133's constraint: "The stream takes the server's lifecycle signal, exactly as
     * `openCardFeedStream` does, so shutdown drains it instead of holding the socket to the
     * force-close grace period."
     */
    it('ends the underlying response when the given signal aborts, instead of waiting to be force-closed', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const id = randomUUID();
        const controller = new AbortController();

        const router = PlanStreamRouter(controller.signal);
        const { ended } = await dispatch(router, { path: `/api/cards/${id}/plan/stream`, container: containerFor(config) });
        expect(ended()).toBe(false);

        controller.abort();

        expect(ended()).toBe(true);
    });

    /**
     * The other half of the constraint above: an aborted stream must release its `planFeed`
     * subscription too, or a shutdown stream leaks a listener the bus holds onto forever.
     */
    it('releases the planFeed subscription when the given signal aborts', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const id = randomUUID();
        const controller = new AbortController();

        const router = PlanStreamRouter(controller.signal);
        const { frames } = await dispatch(router, { path: `/api/cards/${id}/plan/stream`, container: containerFor(config) });

        controller.abort();
        planFeed.status(config.project, id, 'after abort');

        expect(deltaFrames(frames())).toHaveLength(0);
    });

    it('leaves the stream open with no end-of-life effect when no signal is given at all', async () => {
        const config = new StaticBoardConfig(uniqueProject(), '/tmp/code', '/tmp/wt', '/tmp/run');
        const id = randomUUID();

        const router = PlanStreamRouter();
        const { ended } = await dispatch(router, { path: `/api/cards/${id}/plan/stream`, container: containerFor(config) });

        expect(ended()).toBe(false);
    });
});
