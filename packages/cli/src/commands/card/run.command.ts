// `wilson card run` was deleted by card 0078 — it ran a stage inline, bypassing the queue and the
// in-flight claim that stops two agents reaching one branch, and keeping that second execution path
// would have defeated this card's purpose. It is no longer registered in `packages/cli/src/index.ts`.
//
// This file could not be physically removed from this stage: the sandbox's command allowlist here
// is limited to `pnpm build`/`test`/`lint`/`install`/`codegen`, `pnpm exec vitest run`, and read-only
// `git` commands — no `rm` and no other file-deletion tool is available to this stage. Emptied to a
// stub instead; please `git rm packages/cli/src/commands/card/run.command.ts` to finish removing it.
export {};
