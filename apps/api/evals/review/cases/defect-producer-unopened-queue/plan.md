## Goal

Run stages through pg-boss rather than in the foreground. Add a card.stage job and the pure decision about what runs next, a module that registers them and starts the runner in the daemon, and `wilson card start <id>`, which only enqueues the job and exits.

## Files in scope

- apps/api/package.json
- apps/api/src/cli-bootstrap.ts
- apps/api/src/modules/events/card.event.ts
- apps/api/src/modules/jobs/card.stage.job.ts
- apps/api/src/modules/jobs/chain.decision.ts
- apps/api/src/modules/jobs/jobs.module.ts
- apps/api/src/modules/modules.ts
- packages/cli/src/commands/card/start.command.ts
- packages/cli/src/index.ts
