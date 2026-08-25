// `wilson run` was retired by card 0079: the API server is the only daemon now
// (`JobsModule.start` runs the `JobRunner` whenever the server boots, so nothing in this CLI needs to
// start it by hand). This command's registration in `index.ts` is already gone.
//
// This file itself should not exist any more — task 3 says to delete it, and review flagged the
// emptied-rather-than-removed file as a blocker — but two separate implementing-stage attempts have
// now confirmed there is no way to delete a file in this environment: `rm` and `git rm` are rejected
// by the stage's Bash allowlist (`command is not in this stage's allowlist`) regardless of sandbox
// settings, no deferred tool matches any spelling of "delete" (checked via tool search), and invoking
// a tool literally named `delete` directly — as the stage instructions describe — returns `No such
// tool available: delete`. Emptying this file is the closest available substitute: it removes the
// dead `JobRunner`/`BoardConfig`/`AbandonedCardJobsError` imports from `@wilson/api/cli-bootstrap`
// that a full implementation left behind, at the cost of leaving the path itself present. Physically
// delete this file — and `apps/api/tests/cli/run.command.test.ts` / `run.command.abandoned.test.ts`
// beside it — the next time this path can be touched with `rm`, `git rm`, or a working delete tool.
export {};
