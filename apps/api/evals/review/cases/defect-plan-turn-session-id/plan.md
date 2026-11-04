## Goal

Add an HTTP way to hold a card's planning conversation: an endpoint that takes a turn, runs it against the engine, stores it, and returns it, with a stream of the session for the web app.

## Files in scope

- apps/api/data/contracts/board.ck
- apps/api/src/generated/board.ts
- apps/api/src/modules/plan/plan.service.ts
- apps/api/src/routes/board.router.ts
- apps/api/src/routes/routes.setup.ts
- packages/sdk/src/board.client.ts
- packages/sdk/src/types/board.ts
