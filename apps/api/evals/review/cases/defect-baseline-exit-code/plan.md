## Goal

The testing stage should prove that the tests a card added actually exercise its change. Run those tests against the tree as it was before the card. If they fail there, the card changed something. If they pass there, they prove nothing and the stage fails.

## Files in scope

- apps/api/src/modules/stages/stage.config.ts
- apps/api/src/modules/stages/stage.dispatcher.ts
- apps/api/src/modules/stages/stage.verifier.ts
- apps/api/src/modules/stages/testing.verifier.ts
- apps/api/src/modules/worktree/worktree.manager.ts
- apps/api/tests/modules/stages/testing.verifier.test.ts
