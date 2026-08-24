import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FeedRouter, routers } from '#src/routes/routes.setup.js';
import { BoardRouter } from '#src/routes/board.router.js';
import { HealthRouter } from '#src/routes/health.router.js';

/**
 * Every router the server mounts is either generated from a contract, or — for the one route that
 * cannot be, the SSE feed — built by hand in `routes.setup.ts` itself rather than a new file.
 *
 * Card 0019 wrote the health route by hand and said why that was temporary: a hand-written route is
 * the only place the API can drift from the contract that documents it. The health and board
 * routes are generated now; `FeedRouter` (card 0034) is the deliberate, permanent exception —
 * ContractKit emits JSON handlers, and an SSE stream isn't one.
 */
describe('routers', () => {
    it('mounts the generated health and board routers plus the hand-written feed router, and nothing else', () => {
        expect(routers).toEqual([HealthRouter, BoardRouter, FeedRouter]);
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

    it('does not route a write method to any board path — the board surface is read-only', () => {
        expect(BoardRouter.match('/api/cards', 'POST').route).toBe(false);
        expect(BoardRouter.match('/api/cards/0001', 'DELETE').route).toBe(false);
    });
});
