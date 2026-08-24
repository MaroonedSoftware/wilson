import { BoardRouter } from '../generated/board.router.js';
import { healthRouter } from './health.router.js';

/**
 * Every router the server mounts, in one place — adding a router later is one line here.
 *
 * Left untyped as `ServerKitRouterType[]`: that type is the erased, invariant `Router<unknown,
 * unknown>`, so callers cast at the point they hand this to `setupRoutes` instead.
 */
export const routers = [healthRouter, BoardRouter];
