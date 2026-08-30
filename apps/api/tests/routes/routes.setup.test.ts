import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseResponse } from '@maroonedsoftware/koa';
import { FeedRouter, PlanStreamRouter, routers } from '#src/routes/routes.setup.js';
import { BoardRouter } from '#src/routes/board.router.js';
import { HealthRouter } from '#src/routes/health.router.js';
import { SettingsRouter } from '#src/routes/settings.router.js';
import { BoardConfig, ProjectScopedBoardConfig, StaticBoardConfig } from '#modules/board/board.config.js';
import { currentProject } from '#modules/board/project.context.js';
import { ProjectRepository, type ProjectRow } from '#modules/board/project.repository.js';
import { cardFeed } from '#modules/feed/card.feed.js';
import { uniqueProject } from '#tests/support/test.db.js';

/**
 * Every router the server mounts is either generated from a contract, or — for the one route that
 * cannot be, the SSE feed — built by hand in `routes.setup.ts` itself rather than a new file.
 *
 * Card 0019 wrote the health route by hand and said why that was temporary: a hand-written route is
 * the only place the API can drift from the contract that documents it. The health and board
 * routes are generated now; `FeedRouter` (card 0034) is the deliberate, permanent exception —
 * ContractKit emits JSON handlers, and an SSE stream isn't one.
 *
 * `SettingsRouter` (card 0106) joined the same way the board router did: generated from
 * `settings.ck`, and mounted here alongside the others.
 */
describe('routers', () => {
    // Card 0150: `ProjectContextRouter` is mounted first, ahead of the five routers that were the
    // whole array before this card — see the `ProjectContextRouter` describe block below for what
    // it actually does; this test only pins its position.
    it('mounts the project-context router first, then the generated health, board and settings routers plus the two hand-written SSE routers, and nothing else', () => {
        const mounted = routers();

        expect(mounted).toHaveLength(6);
        expect(mounted[1]).toBe(HealthRouter);
        expect(mounted[2]).toBe(BoardRouter);
        expect(mounted[3]).toBe(SettingsRouter);
        // FeedRouter (card 0042) and PlanStreamRouter (card 0133) are factories, not constants: each
        // call builds a fresh router, so this checks they mount a working route rather than
        // comparing object identity against another freshly-built instance.
        expect(mounted[4].match('/api/feed', 'GET').route).toBe(true);
        expect(mounted[5].match('/api/cards/0001/plan/stream', 'GET').route).toBe(true);
    });

    // Card 0042: `routers` and `FeedRouter` became factories that take the server's lifecycle
    // signal, so shutdown can drain an open `/api/feed` stream instead of waiting out the
    // force-close grace period. Card 0133's `PlanStreamRouter` takes the same signal for the same
    // reason. The other three routers have no long-lived connection to drain and must come back
    // untouched regardless of whether a signal is given.
    it('accepts a lifecycle signal and still mounts the same routers plus working feed and plan-stream routers', () => {
        const controller = new AbortController();
        const mounted = routers(controller.signal);

        expect(mounted).toHaveLength(6);
        expect(mounted[1]).toBe(HealthRouter);
        expect(mounted[2]).toBe(BoardRouter);
        expect(mounted[3]).toBe(SettingsRouter);
        expect(mounted[4].match('/api/feed', 'GET').route).toBe(true);
        expect(mounted[5].match('/api/cards/0001/plan/stream', 'GET').route).toBe(true);
    });

    it('builds a working feed router whether or not a signal is given', () => {
        expect(FeedRouter().match('/api/feed', 'GET').route).toBe(true);
        expect(FeedRouter(new AbortController().signal).match('/api/feed', 'GET').route).toBe(true);
    });

    it('builds a working plan-stream router whether or not a signal is given', () => {
        expect(PlanStreamRouter().match('/api/cards/0001/plan/stream', 'GET').route).toBe(true);
        expect(PlanStreamRouter(new AbortController().signal).match('/api/cards/0001/plan/stream', 'GET').route).toBe(true);
    });

    /**
     * The invariant, not just today's list. A hand-written router would satisfy the assertion above
     * simply by being added to it, so this checks provenance instead: every router file beside
     * `routes.setup.ts` has to carry the header ContractKit writes, naming the contract it came
     * from. Location cannot prove that any more now that generated routers live here too — but a
     * file claiming a source contract is a stronger claim than a file sitting in the right folder.
     */
    it('has no router beside routes.setup.ts that was not generated from a contract', async () => {
        const dir = fileURLToPath(new URL('../../src/routes/', import.meta.url));
        const files = (await readdir(dir)).sort();
        expect(files).toContain('routes.setup.ts');

        for (const file of files.filter(f => f !== 'routes.setup.ts')) {
            expect(file, `${file} is beside routes.setup.ts but is not a router`).toMatch(/\.router\.ts$/);
            const source = await readFile(join(dir, file), 'utf8');
            expect(source, `${file} carries no "generated from" header`).toMatch(/generated from \[[^\]]+\.ck\]/);
        }
    });

    it.each([['/api/cards'], ['/api/cards/0001'], ['/api/cards/0001/events'], ['/api/cards/0001/versions']])(
        'routes GET %s to the board router',
        path => {
            expect(BoardRouter.match(path, 'GET').route).toBe(true);
        },
    );

    it('routes GET /api/health to the health router', () => {
        expect(HealthRouter.match('/api/health', 'GET').route).toBe(true);
    });

    it('routes GET /api/feed to the feed router', () => {
        expect(FeedRouter().match('/api/feed', 'GET').route).toBe(true);
    });

    // Card 0075 gave the board a write surface — create, move, edit — so "read-only" no longer
    // holds. What still holds is that only those three are routed: an undeclared write method
    // (DELETE, PUT) must not match, the same way an undeclared path never did.
    it.each([
        ['POST', '/api/cards'],
        ['PATCH', '/api/cards/0001'],
        ['POST', '/api/cards/0001/rename'],
        ['POST', '/api/cards/0001/move'],
        // Card 0091: the parking lot's reposition endpoint, following the sub-resource shape `move`
        // established.
        ['POST', '/api/cards/0001/reposition'],
    ])('routes %s %s to the board router', (method, path) => {
        expect(BoardRouter.match(path, method).route).toBe(true);
    });

    it('does not route an undeclared write method to any board path', () => {
        expect(BoardRouter.match('/api/cards', 'DELETE').route).toBe(false);
        expect(BoardRouter.match('/api/cards/0001', 'PUT').route).toBe(false);
    });

    it('does not route an undeclared method to the reposition path', () => {
        expect(BoardRouter.match('/api/cards/0001/reposition', 'GET').route).toBe(false);
        expect(BoardRouter.match('/api/cards/0001/reposition', 'DELETE').route).toBe(false);
    });

    // Card 0094: renaming is a sub-resource POST, not a `title` field folded into `PATCH .../id` —
    // an undeclared method on the rename path must not match, the same way it does not for any other
    // board write path.
    it('does not route an undeclared method to the rename path', () => {
        expect(BoardRouter.match('/api/cards/0001/rename', 'GET').route).toBe(false);
        expect(BoardRouter.match('/api/cards/0001/rename', 'PATCH').route).toBe(false);
    });

    // Card 0113: reading a card's recorded scope-check division, and turning it into cards.
    it('routes GET /api/cards/0001/division to the board router', () => {
        expect(BoardRouter.match('/api/cards/0001/division', 'GET').route).toBe(true);
    });

    it('routes POST /api/cards/0001/split to the board router', () => {
        expect(BoardRouter.match('/api/cards/0001/split', 'POST').route).toBe(true);
    });

    it('does not route an undeclared method to either of the card 0113 paths', () => {
        expect(BoardRouter.match('/api/cards/0001/division', 'POST').route).toBe(false);
        expect(BoardRouter.match('/api/cards/0001/split', 'GET').route).toBe(false);
    });

    // Card 0133: the ordinary JSON half of a card's planning conversation. `GET .../plan/stream`,
    // the other half, is not generated — it is `PlanStreamRouter`, exercised separately above and in
    // `plan.stream.route.test.ts`.
    it('routes POST /api/cards/0001/plan/turn to the board router', () => {
        expect(BoardRouter.match('/api/cards/0001/plan/turn', 'POST').route).toBe(true);
    });

    it('does not route an undeclared method to the plan/turn path', () => {
        expect(BoardRouter.match('/api/cards/0001/plan/turn', 'GET').route).toBe(false);
        expect(BoardRouter.match('/api/cards/0001/plan/turn', 'DELETE').route).toBe(false);
    });

    // Card 0140: reading a card's draft.md over HTTP, beside the other plan/* operations.
    it('routes GET /api/cards/0001/plan/draft to the board router', () => {
        expect(BoardRouter.match('/api/cards/0001/plan/draft', 'GET').route).toBe(true);
    });

    it('does not route an undeclared method to the plan/draft path', () => {
        expect(BoardRouter.match('/api/cards/0001/plan/draft', 'POST').route).toBe(false);
        expect(BoardRouter.match('/api/cards/0001/plan/draft', 'DELETE').route).toBe(false);
    });

    // Card 0106: the poller's on/off switch, read and written over the API.
    it.each([['GET'], ['PUT']])('routes %s /api/settings/poller-enabled to the settings router', method => {
        expect(SettingsRouter.match('/api/settings/poller-enabled', method).route).toBe(true);
    });

    it('does not route an undeclared method to the settings path', () => {
        expect(SettingsRouter.match('/api/settings/poller-enabled', 'POST').route).toBe(false);
        expect(SettingsRouter.match('/api/settings/poller-enabled', 'DELETE').route).toBe(false);
    });

    // Card 0115: the poller's interval and card.stage's concurrency, read and written over the API
    // the same way poller-enabled already is.
    it.each([['GET'], ['PUT']])('routes %s /api/settings/poller-interval-ms to the settings router', method => {
        expect(SettingsRouter.match('/api/settings/poller-interval-ms', method).route).toBe(true);
    });

    it.each([['GET'], ['PUT']])('routes %s /api/settings/card-stage-concurrency to the settings router', method => {
        expect(SettingsRouter.match('/api/settings/card-stage-concurrency', method).route).toBe(true);
    });

    it('does not route an undeclared method to either card 0115 settings path', () => {
        expect(SettingsRouter.match('/api/settings/poller-interval-ms', 'POST').route).toBe(false);
        expect(SettingsRouter.match('/api/settings/poller-interval-ms', 'DELETE').route).toBe(false);
        expect(SettingsRouter.match('/api/settings/card-stage-concurrency', 'POST').route).toBe(false);
        expect(SettingsRouter.match('/api/settings/card-stage-concurrency', 'DELETE').route).toBe(false);
    });

    // Card 0107: the notify webhook and its base URL, read and written over the API the same way
    // the other settings already are.
    it.each([['GET'], ['PUT']])('routes %s /api/settings/notify-webhook to the settings router', method => {
        expect(SettingsRouter.match('/api/settings/notify-webhook', method).route).toBe(true);
    });

    it('does not route an undeclared method to the notify-webhook settings path', () => {
        expect(SettingsRouter.match('/api/settings/notify-webhook', 'POST').route).toBe(false);
        expect(SettingsRouter.match('/api/settings/notify-webhook', 'DELETE').route).toBe(false);
    });

    // Card 0144: the merge pipeline's rehearsal switch, read and written over the API the same way
    // every other operational setting already is.
    it.each([['GET'], ['PUT']])('routes %s /api/settings/dry-run to the settings router', method => {
        expect(SettingsRouter.match('/api/settings/dry-run', method).route).toBe(true);
    });

    it('does not route an undeclared method to the dry-run settings path', () => {
        expect(SettingsRouter.match('/api/settings/dry-run', 'POST').route).toBe(false);
        expect(SettingsRouter.match('/api/settings/dry-run', 'DELETE').route).toBe(false);
    });
});

/**
 * Card 0150. `ProjectContextRouter` is not exported — it is reached the same way any other router
 * in the array is meant to be used, by mounting it (`routers()[0]`, pinned as the first entry by
 * the test above) and driving `@koa/router`'s own public `routes()` dispatch, the same pattern
 * `plan.stream.route.test.ts` already uses for `PlanStreamRouter`. A fake `ctx.get` stands in for
 * Koa's real header lookup, matching case-insensitively the way the real one does.
 */
describe('ProjectContextRouter', () => {
    const containerFor = (board: BoardConfig, find: (name: string) => Promise<ProjectRow | undefined>): { get: (token: unknown) => unknown } => ({
        get: (token: unknown) => {
            if (token === BoardConfig) return board;
            if (token === ProjectRepository) return { find };
            throw new Error(`unexpected container.get(${String(token)})`);
        },
    });

    const dispatch = (
        headerValue: string | undefined,
        board: BoardConfig,
        find: (name: string) => Promise<ProjectRow | undefined>,
        next: () => Promise<void>,
        query: Record<string, unknown> = {},
    ): Promise<void> => {
        const router = routers()[0]!;
        const ctx = {
            method: 'GET',
            path: '/api/cards',
            request: {},
            params: {},
            headers: headerValue ? { 'x-wilson-project': headerValue } : {},
            query,
            get: (name: string) => (headerValue && name.toLowerCase() === 'x-wilson-project' ? headerValue : ''),
            container: containerFor(board, find),
        };
        return router.routes()(ctx as never, next);
    };

    it('runs the request inside the board\'s own configured project, and never queries ProjectRepository, when no project header is given', async () => {
        const board = new StaticBoardConfig('configured-project', '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        const find = vi.fn(async () => undefined);
        let observed: string | undefined;

        await dispatch(undefined, board, find, async () => {
            observed = currentProject();
        });

        expect(observed).toBe('configured-project');
        expect(find).not.toHaveBeenCalled();
        // The scope opened for the request is gone once the handler settles — a later request (or a
        // later test) must never see a leftover project from this one.
        expect(currentProject()).toBeUndefined();
    });

    it('registers the named project\'s row on the board and runs the request inside its context, when the header names a registered project', async () => {
        const board = new ProjectScopedBoardConfig('configured-project');
        const row: ProjectRow = {
            name: 'other-project',
            boardRoot: '/other/board',
            codeRoot: '/other/code',
            worktreeRoot: '/other/wt',
            runRoot: '/other/run',
        };
        const find = vi.fn(async (name: string) => (name === 'other-project' ? row : undefined));
        let observedProject: string | undefined;
        let observedBoardRoot: string | undefined;

        await dispatch('other-project', board, find, async () => {
            observedProject = currentProject();
            observedBoardRoot = board.boardRoot;
        });

        expect(find).toHaveBeenCalledWith('other-project');
        expect(observedProject).toBe('other-project');
        expect(observedBoardRoot).toBe('/other/board');
        expect(currentProject()).toBeUndefined();
    });

    it('refuses an unregistered project header with a 400 naming it, and never runs the rest of the request', async () => {
        const board = new ProjectScopedBoardConfig('configured-project');
        const find = vi.fn(async () => undefined);
        const next = vi.fn();

        await expect(dispatch('ghost-project', board, find, next)).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining('ghost-project') },
        });

        expect(next).not.toHaveBeenCalled();
        expect(currentProject()).toBeUndefined();
    });

    /**
     * Card 0153: `EventSource` cannot set `X-Wilson-Project`, so the two SSE routes (`FeedRouter`,
     * `PlanStreamRouter`) name their project with `?project=` instead — read here the same way
     * `resolveLastEventId` already reads `?lastEventId=`, via `firstQueryValue`. No header is given
     * on this dispatch, so this exercises the query-only path directly, not the header path the
     * tests above already cover.
     */
    it('registers the query-named project\'s row on the board and runs the request inside its context, when no header is given but a ?project= query value is', async () => {
        const board = new ProjectScopedBoardConfig('configured-project');
        const row: ProjectRow = {
            name: 'other-project',
            boardRoot: '/other/board',
            codeRoot: '/other/code',
            worktreeRoot: '/other/wt',
            runRoot: '/other/run',
        };
        const find = vi.fn(async (name: string) => (name === 'other-project' ? row : undefined));
        let observedProject: string | undefined;
        let observedBoardRoot: string | undefined;

        await dispatch(
            undefined,
            board,
            find,
            async () => {
                observedProject = currentProject();
                observedBoardRoot = board.boardRoot;
            },
            { project: 'other-project' },
        );

        expect(find).toHaveBeenCalledWith('other-project');
        expect(observedProject).toBe('other-project');
        expect(observedBoardRoot).toBe('/other/board');
        expect(currentProject()).toBeUndefined();
    });

    it('prefers the header over a ?project= query value when both name a project, rather than the query silently winning', async () => {
        const board = new ProjectScopedBoardConfig('configured-project');
        const headerRow: ProjectRow = {
            name: 'header-project',
            boardRoot: '/header/board',
            codeRoot: '/header/code',
            worktreeRoot: '/header/wt',
            runRoot: '/header/run',
        };
        const find = vi.fn(async (name: string) => (name === 'header-project' ? headerRow : undefined));
        let observedProject: string | undefined;

        await dispatch(
            'header-project',
            board,
            find,
            async () => {
                observedProject = currentProject();
            },
            { project: 'query-project' },
        );

        expect(find).toHaveBeenCalledWith('header-project');
        expect(find).not.toHaveBeenCalledWith('query-project');
        expect(observedProject).toBe('header-project');
    });

    it('refuses an unregistered ?project= query value with a 400 naming it, and never runs the rest of the request', async () => {
        const board = new ProjectScopedBoardConfig('configured-project');
        const find = vi.fn(async () => undefined);
        const next = vi.fn();

        await expect(dispatch(undefined, board, find, next, { project: 'ghost-project' })).rejects.toMatchObject({
            statusCode: 400,
            details: { reason: expect.stringContaining('ghost-project') },
        });

        expect(next).not.toHaveBeenCalled();
        expect(currentProject()).toBeUndefined();
    });

    it('falls back to the board\'s own configured project when a ?project= query value is present but blank, the same as no query at all', async () => {
        const board = new StaticBoardConfig('configured-project', '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        const find = vi.fn(async () => undefined);
        let observed: string | undefined;

        await dispatch(
            undefined,
            board,
            find,
            async () => {
                observed = currentProject();
            },
            { project: '' },
        );

        expect(observed).toBe('configured-project');
        expect(find).not.toHaveBeenCalled();
    });
});

/**
 * Card 0150. `FeedRouter` now threads `ctx.container.get(BoardConfig).project` into
 * `openCardFeedStream` so `/api/feed` only ever delivers the requesting project's card events.
 * Driven through the real `cardFeed` singleton (`#modules/feed/card.feed.js`) with process-unique
 * project names, so this is unaffected by whatever other suites publish onto that same bus.
 */
describe('FeedRouter project scoping', () => {
    // `openSseStream` starts a 15s heartbeat interval on every call; fake timers keep it from
    // becoming a real, leaking timer across test runs (same reason card.feed.route.test.ts does
    // this).
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const fakeRes = (): { res: SseResponse; frames: () => string[] } => {
        const chunks: string[] = [];
        const res: SseResponse = {
            writeHead: () => undefined,
            write: (chunk: string) => {
                chunks.push(chunk);
                return true;
            },
            end: () => undefined,
            destroy: () => undefined,
            setTimeout: () => undefined,
            on: () => undefined,
        };
        return { res, frames: () => [...chunks] };
    };

    const cardIdsOf = (frames: string[]): string[] =>
        frames
            .filter(frame => frame.startsWith('event: card\n'))
            .map(frame => {
                const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
                if (!dataLine) throw new Error(`frame carried no data line: ${frame}`);
                return (JSON.parse(dataLine.slice('data: '.length)) as { correlationId: string }).correlationId;
            });

    it('only delivers the board\'s own project\'s cards over /api/feed, never another registered project\'s', async () => {
        const project = uniqueProject();
        const otherProject = uniqueProject();
        const board = new StaticBoardConfig(project, '/tmp/board', '/tmp/code', '/tmp/wt', '/tmp/run');
        cardFeed.status(project, 'mine', 'stage.dispatched', { stage: 'implementing' });
        cardFeed.status(otherProject, 'not-mine', 'stage.dispatched', { stage: 'implementing' });

        const router = FeedRouter();
        const { res, frames } = fakeRes();
        const ctx = {
            method: 'GET',
            path: '/api/feed',
            request: {},
            params: {},
            headers: {},
            query: {},
            container: { get: (token: unknown) => (token === BoardConfig ? board : undefined) },
            status: 0,
            respond: true,
            res,
        };

        await router.routes()(ctx as never, async () => {});

        expect(cardIdsOf(frames())).toEqual(['mine']);
    });
});
