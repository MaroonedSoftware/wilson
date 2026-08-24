import { describe, expect, it } from 'vitest';
import { routers } from '#src/routes/routes.setup.js';
import { healthRouter } from '#src/routes/health.router.js';
import { BoardRouter } from '#src/generated/board.router.js';

/**
 * `routes.setup.ts` previously listed only `healthRouter`. This card mounts the generated board
 * router beside it, so `GET /api/cards` (and its siblings) actually reach the server rather than
 * existing only as a contract and a service nothing wires up.
 */
describe('routers', () => {
    it('mounts the board router alongside the health router', () => {
        expect(routers).toEqual([healthRouter, BoardRouter]);
    });

    it.each([['/api/cards'], ['/api/cards/0001'], ['/api/cards/0001/events'], ['/api/cards/0001/versions']])(
        'routes GET %s to the board router',
        path => {
            expect(BoardRouter.match(path, 'GET').route).toBe(true);
        },
    );

    it('does not route a write method to any board path — this card is read-only', () => {
        expect(BoardRouter.match('/api/cards', 'POST').route).toBe(false);
        expect(BoardRouter.match('/api/cards/0001', 'DELETE').route).toBe(false);
    });
});
