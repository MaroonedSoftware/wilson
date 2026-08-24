import { BoardRouter } from './board.router.js';
import { HealthRouter } from './health.router.js';

/**
 * Every router the server mounts, in one place — adding a router later is one line here.
 *
 * The `*.router.ts` files beside this one are generated from `data/contracts/*.ck` and must not be
 * edited; regenerate with `pnpm codegen`. This file is the only hand-written thing in the directory.
 *
 * Every route is generated. Card 0019 wrote the health route by hand and said why that was
 * temporary: a hand-written route is the only place the API can drift from the contract that
 * documents it, and the SDK the web app consumes would not know it exists.
 *
 * Left untyped as `ServerKitRouterType[]`: that type is the erased, invariant `Router<unknown,
 * unknown>`, so callers cast at the point they hand this to `setupRoutes` instead.
 */
export const routers = [HealthRouter, BoardRouter];
