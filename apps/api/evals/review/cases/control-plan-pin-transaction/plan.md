## Goal

Advance a card's plan pin in the same transaction as its stage transition, so the two can never disagree.

## Files in scope

- apps/api/src/modules/board/board.repository.ts
- apps/api/src/modules/board/postgres.board.repository.ts
- apps/api/src/modules/stages/stage.dispatcher.ts
- apps/api/tests/modules/stages/stage.dispatcher.plan-pin-advance.test.ts
