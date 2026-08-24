import { BoardRouter } from '../generated/board.router.js';
import { HealthRouter } from '../generated/health.router.js';

/**
 * Every router the server mounts, in one place — adding a router later is one line here.
 *
 * All of them are generated. Card 0019 wrote the health route by hand and said why that was
 * temporary: mixing a hand-written route with generated ones sets the wrong precedent, because the
 * hand-written one is the only place the API can drift from the contract that documents it.
 *
 * Left untyped as `ServerKitRouterType[]`: that type is the erased, invariant `Router<unknown,
 * unknown>`, so callers cast at the point they hand this to `setupRoutes` instead.
 */
export const routers = [HealthRouter, BoardRouter];
