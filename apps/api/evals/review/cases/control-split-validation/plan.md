## Goal

Move split validation into board/split.ts and add helpers that detect a dependency cycle among the pieces and a split that goes too deep.

## Files in scope

- apps/api/src/modules/board/board.write.service.ts
- apps/api/src/modules/board/split.ts
- apps/api/tests/modules/board/split.test.ts
