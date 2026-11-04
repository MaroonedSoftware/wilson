## Goal

When an external ticket behind a card closes, the board should react: pull a card that has not started, and flag one with work under way for a person, once only, and notify. Also tell the ticket when its card reaches a result.

## Files in scope

- apps/api/src/modules/notify/notification.ts
- apps/api/src/modules/sources/card.source.ts
- apps/api/src/modules/sources/github.issues.source.ts
- apps/api/src/modules/sources/inbound.card.writer.ts
- apps/api/src/modules/stages/stage.dispatcher.ts
- apps/api/tests/modules/sources/card.source.test.ts
- apps/api/tests/modules/sources/github.issues.source.test.ts
- apps/api/tests/modules/sources/inbound.card.writer.test.ts
- apps/api/tests/modules/sources/source.poller.test.ts
- apps/api/tests/modules/stages/stage.dispatcher.test.ts
