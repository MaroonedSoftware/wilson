import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { routers } from '#src/routes/routes.setup.js';
import { BoardRouter } from '#src/generated/board.router.js';
import { HealthRouter } from '#src/generated/health.router.js';

/**
 * Every router the server mounts is generated from a contract.
 *
 * Card 0019 wrote the health route by hand and said why that was temporary: a hand-written route is
 * the only place the API can drift from the contract that documents it. It is now generated too, so
 * the rule has no exceptions — and a rule with no exceptions is worth asserting rather than trusting.
 */
describe('routers', () => {
    it('mounts the generated health and board routers, and nothing else', () => {
        expect(routers).toEqual([HealthRouter, BoardRouter]);
    });

    /**
     * The invariant, not just today's list. A hand-written router would satisfy the assertion above
     * simply by being added to it; this fails instead, which is the point — `src/routes/` holds the
     * mounting list and nothing else, because every route lives in `src/generated/`.
     */
    it('keeps no route definitions outside src/generated', async () => {
        const dir = fileURLToPath(new URL('../../src/routes/', import.meta.url));
        expect((await readdir(dir)).sort()).toEqual(['routes.setup.ts']);
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

    it('does not route a write method to any board path — the board surface is read-only', () => {
        expect(BoardRouter.match('/api/cards', 'POST').route).toBe(false);
        expect(BoardRouter.match('/api/cards/0001', 'DELETE').route).toBe(false);
    });
});
