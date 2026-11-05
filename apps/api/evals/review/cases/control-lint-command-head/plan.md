## Goal

The plan lint accepts any backticked span with several tokens and a lowercase first word as a command, so a column definition quoted from a migration gets reported. Require the head to be a binary.

## Files in scope

- apps/api/src/modules/agent/command.allowlist.ts
- apps/api/src/modules/board/plan.lint.service.ts
- apps/api/tests/modules/board/plan.lint.service.test.ts
