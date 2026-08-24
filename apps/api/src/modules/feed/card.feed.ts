import { ServerFeed } from '@maroonedsoftware/serverfeed';

/**
 * The Postgres `NOTIFY`/`LISTEN` channel the card feed rides. See `card.feed.listener.ts` for the
 * subscriber and `event.log.ts` for the publisher.
 */
export const CARD_FEED_CHANNEL = 'card_events';

/**
 * The card feed: current stage and most recent event, keyed by card
 * (`ServerFeed`'s `${source}:${correlationId}` snapshot key, with `source` the project and
 * `correlationId` the card id).
 *
 * A plain module-level singleton rather than a DI registration. `data.module.ts` and
 * `events.module.ts` — where this app's other cross-cutting singletons (the Kysely pool,
 * `EventLog`) are wired into the container — are outside this card's files in scope. That is no
 * loss: `ServerFeed` has no `@Injectable()` decorator (its own docs say to register it as a value,
 * not a class), so a plain singleton is exactly how it is meant to be held.
 */
export const cardFeed = new ServerFeed();
