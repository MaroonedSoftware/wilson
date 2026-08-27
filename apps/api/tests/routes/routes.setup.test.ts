import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FeedRouter, routers } from '#src/routes/routes.setup.js';
import { BoardRouter } from '#src/routes/board.router.js';
import { HealthRouter } from '#src/routes/health.router.js';
import { SettingsRouter } from '#src/routes/settings.router.js';

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
    it('mounts the generated health, board and settings routers plus the hand-written feed router, and nothing else', () => {
        const mounted = routers();

        expect(mounted).toHaveLength(4);
        expect(mounted[0]).toBe(HealthRouter);
        expect(mounted[1]).toBe(BoardRouter);
        expect(mounted[2]).toBe(SettingsRouter);
        // FeedRouter (card 0042) is a factory, not a constant: each call builds a fresh router, so
        // this checks it mounts a working `/api/feed` route rather than comparing object identity
        // against another freshly-built instance.
        expect(mounted[3].match('/api/feed', 'GET').route).toBe(true);
    });

    // Card 0042: `routers` and `FeedRouter` became factories that take the server's lifecycle
    // signal, so shutdown can drain an open `/api/feed` stream instead of waiting out the
    // force-close grace period. The other three routers have no long-lived connection to drain and
    // must come back untouched regardless of whether a signal is given.
    it('accepts a lifecycle signal and still mounts the same three routers plus a working feed router', () => {
        const controller = new AbortController();
        const mounted = routers(controller.signal);

        expect(mounted).toHaveLength(4);
        expect(mounted[0]).toBe(HealthRouter);
        expect(mounted[1]).toBe(BoardRouter);
        expect(mounted[2]).toBe(SettingsRouter);
        expect(mounted[3].match('/api/feed', 'GET').route).toBe(true);
    });

    it('builds a working feed router whether or not a signal is given', () => {
        expect(FeedRouter().match('/api/feed', 'GET').route).toBe(true);
        expect(FeedRouter(new AbortController().signal).match('/api/feed', 'GET').route).toBe(true);
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
});
