## Goal

Wire live card updates to the web app at GET /api/feed. Appending an event notifies a Postgres channel in the same transaction, and a listener fans each notification out to the open streams.

## Files in scope

- apps/api/package.json
- apps/api/src/modules/events/event.log.ts
- apps/api/src/modules/feed/card.feed.listener.ts
- apps/api/src/modules/feed/card.feed.route.ts
- apps/api/src/modules/feed/card.feed.ts
- apps/api/src/routes/routes.setup.ts
- apps/api/src/server/setup.server.ts
- apps/api/tests/routes/routes.setup.test.ts
