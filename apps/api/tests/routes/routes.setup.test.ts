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
        expect(routers).toEqual([HealthRouter, BoardRouter, SettingsRouter, FeedRouter]);
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
        expect(FeedRouter.match('/api/feed', 'GET').route).toBe(true);
    });

    // Card 0075 gave the board a write surface — create, move, edit — so "read-only" no longer
    // holds. What still holds is that only those three are routed: an undeclared write method
    // (DELETE, PUT) must not match, the same way an undeclared path never did.
    it.each([
        ['POST', '/api/cards'],
        ['PATCH', '/api/cards/0001'],
        ['POST', '/api/cards/0001/move'],
    ])('routes %s %s to the board router', (method, path) => {
        expect(BoardRouter.match(path, method).route).toBe(true);
    });

    it('does not route an undeclared write method to any board path', () => {
        expect(BoardRouter.match('/api/cards', 'DELETE').route).toBe(false);
        expect(BoardRouter.match('/api/cards/0001', 'PUT').route).toBe(false);
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
});
