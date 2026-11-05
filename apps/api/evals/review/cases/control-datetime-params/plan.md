## Goal

Database parameters holding a DateTime went out JSON-quoted, which timestamptz accepts only by skipping punctuation. Send ISO strings, refuse invalid values, and drop the event log's raw workaround.

## Files in scope

- apps/api/src/modules/board/board.module.ts
- apps/api/src/modules/data/data.module.ts
- apps/api/src/modules/data/kysely.plugins.ts
- apps/api/src/modules/events/event.log.ts
- apps/api/tests/modules/data/kysely.plugins.test.ts
- apps/api/tests/support/test.db.ts
