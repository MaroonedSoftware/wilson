## Goal

The routes key their queries with a project prefix and the mutations do not, so mutations leave the card page and board stale. Have the mutations invalidate and update the matching queries in either shape, and cover the board and card page with tests.

## Files in scope

- apps/web/src/components/CardDetail.tsx
- apps/web/src/lib/mutations.ts
- apps/web/tests/board.dnd.test.ts
- apps/web/tests/board.reorder.test.ts
- apps/web/tests/card-detail.actions.test.ts
- apps/web/tests/comment-draft.test.ts
- apps/web/tests/flagged.test.ts
- apps/web/tests/new-card-control.test.ts
