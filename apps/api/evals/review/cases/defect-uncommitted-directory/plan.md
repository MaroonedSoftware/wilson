## Goal

A read-only stage must be judged on what it wrote during its own run. Add a way to ask the worktree which paths are touched but not committed, and have the review verifier use it for its check that the reviewer edited nothing.

## Files in scope

- apps/api/src/modules/stages/review.verifier.ts
- apps/api/src/modules/worktree/worktree.manager.ts
- apps/api/tests/modules/worktree/worktree.manager.test.ts
