## Goal

When a stage is retried after a judged failure, its plan should say what went wrong before: a short bullet per failed attempt in a Previous attempts section, with the reasons and the preserved patch from that attempt, kept out of what a person edits.

## Files in scope

- apps/api/src/modules/board/append.attempts.ts
- apps/api/src/modules/stages/stage.dispatcher.ts
