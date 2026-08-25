// `wilson run` was retired by card 0079: the API server is the only daemon now
// (`JobsModule.start` runs the `JobRunner` whenever the server boots, so nothing in this CLI needs to
// start it by hand). This command's registration in `index.ts` is already gone.
//
// This file itself should not exist any more — task 3 says to delete it — but the stage that made
// this change had no delete tool available (the Bash allowlist covers only `pnpm build/test/lint/
// install/codegen`, `pnpm exec vitest run`, and read-only `git`; no `rm`, no `git rm`, and no
// dedicated delete tool responded despite the stage instructions describing one). Emptying this file
// is the closest available substitute: it removes the dead `JobRunner`/`BoardConfig`/
// `AbandonedCardJobsError` imports from `@wilson/api/cli-bootstrap` that a full implementation left
// behind, at the cost of leaving the path itself present. Physically delete this file — and
// `apps/api/tests/cli/run.command.test.ts` / `run.command.abandoned.test.ts` beside it — the next
// time this path can be touched with `rm` or a working delete tool.
export {};
