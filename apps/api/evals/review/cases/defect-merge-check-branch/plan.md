## Goal

Let a person merge a card at ready from the board, with no checkout: compute the merge with git merge-tree, run the testing stage's suite against it in a scratch worktree, and land it with a compare-and-swap on the ref. Report conflicts and a failed suite to the caller.

## Files in scope

- apps/api/data/contracts/board.ck
- apps/api/src/generated/board.ts
- apps/api/src/modules/board/board.write.service.ts
- apps/api/src/modules/board/git.ts
- apps/api/src/modules/worktree/worktree.manager.ts
- apps/api/src/routes/board.router.ts
- apps/web/src/components/CardDetail.tsx
- packages/sdk/src/board.client.ts
- packages/sdk/src/types/board.ts
