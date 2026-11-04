## Goal

Scope-check misses plans that do many different things once each, since breadth only counts repetition. Add a depth threshold on the number of groups, so a plan with too many kinds of work is treated as too large.

## Files in scope

- apps/api/src/modules/stages/scope.check.verifier.ts
