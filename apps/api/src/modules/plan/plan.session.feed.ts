import { ServerFeed } from '@maroonedsoftware/serverfeed';

/**
 * Assistant text deltas for a live planning session, keyed by card (`ServerFeed`'s
 * `${source}:${correlationId}` scheme — `source` the project, `correlationId` the card id, the same
 * pairing `card.feed.ts` uses).
 *
 * A plain module-level singleton, following `card.feed.ts`'s own reasoning: `ServerFeed` has no
 * `@Injectable()` decorator (its own docs say to register it as a value, not a class), so a plain
 * singleton is exactly how it is meant to be held.
 *
 * Unlike `cardFeed`, nothing bridges this one across processes. A live planning session's `query()`
 * (`plan.session.agent.ts`) exists only inside the process that is holding it
 * (`plan.session.registry.ts`), so there is no cross-process event to `NOTIFY`/`LISTEN` for the way
 * `card.feed.listener.ts` does for `cardFeed` — a delta is only ever published by, and only ever
 * needs delivering within, the one process that produced it.
 */
export const planFeed = new ServerFeed();
