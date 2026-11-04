## Goal

Add a review stage after testing. It reads the card's diff and reports a verdict and findings through a structured result. Add a verifier that holds the report to what the runner can check: the reviewer did not edit anything, the result parses, and every finding cites a real file and line in the diff.

## Files in scope

- apps/api/src/modules/agent/tools/index.ts
- apps/api/src/modules/stages/review.verifier.ts
- apps/api/src/modules/stages/stage.dispatcher.ts
- apps/api/src/modules/stages/stage.result.ts
- apps/api/src/modules/stages/stage.verifier.ts
- apps/api/src/modules/stages/stages.module.ts
