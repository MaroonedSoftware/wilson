## Goal

A stage placed on a host had only its own card's preserved patch. Copy every board card's patch that exists here to the same place under the host's run root, and rewrite this machine's run root in the plan copied there, so a path in the plan resolves on the host.

## Files in scope

- apps/api/src/modules/stages/stage.dispatcher.ts
- apps/api/tests/modules/stages/stage.dispatcher.placement.test.ts
