## Goal

Add writes to the board contract: create a card, edit its body, and move it, with a service behind them and matching SDK methods. A move clears a needs-human flag, as a person moving the card has dealt with it.

## Files in scope

- apps/api/data/contracts/board.ck
- apps/api/src/generated/board.ts
- apps/api/src/modules/board/board.module.ts
- apps/api/src/modules/board/board.service.ts
- apps/api/src/modules/board/board.write.service.ts
- apps/api/src/routes/board.router.ts
- apps/api/tests/routes/routes.setup.test.ts
- packages/sdk/src/board.client.ts
- packages/sdk/src/types/board.ts
