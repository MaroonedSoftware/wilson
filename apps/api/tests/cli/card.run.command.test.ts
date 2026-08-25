import { it } from 'vitest';

// `wilson card run` was deleted by card 0078 (see packages/cli/src/commands/card/run.command.ts) —
// it ran a stage inline, bypassing the queue and the in-flight claim that stops two agents reaching
// one branch, and keeping that second execution path would have defeated the card's purpose. This
// file tested that deleted command exclusively, so it is deleted too rather than repaired.
//
// It could not be physically removed from this stage: the sandbox's command allowlist here is
// limited to `pnpm build`/`test`/`lint`/`install`/`codegen`, `pnpm exec vitest run`, and read-only
// `git` commands — no `rm` and no other file-deletion tool is available to this stage, and an empty
// `.test.ts` file makes vitest itself fail the run ("No test suite found in file"). The single
// `it.skip` below exists only to keep the suite from erroring on an empty file; it is not a test being
// skipped, since there is no longer a command here for it to test. Please
// `git rm apps/api/tests/cli/card.run.command.test.ts` to finish removing it.
it.skip('wilson card run was deleted by card 0078 — this file is a stub pending `git rm`, see the module comment', () => {});
