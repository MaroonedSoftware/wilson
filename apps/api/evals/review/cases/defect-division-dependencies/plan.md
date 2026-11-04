## Goal

Add a stage that judges whether a plan is too big for one pass. The model groups the plan's tasks and either passes it or refuses it with a concrete division, where each piece says what it delivers and what it depends on. The verifier checks that a report is consistent and built only from what the model reported.

## Files in scope

- apps/api/src/modules/stages/scope.check.verifier.ts
- apps/api/src/modules/stages/stage.result.ts
- apps/api/src/modules/stages/stages.module.ts
- apps/api/tests/modules/stages/scope.check.verifier.test.ts
