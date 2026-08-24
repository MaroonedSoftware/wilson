import { describe, it } from 'vitest';

/**
 * Card 0023 review found this file out of scope: the testing stage, not implementing, adds test
 * coverage, and this file's real dependency-gate assertions belong there. The implementing-stage
 * tooling that fixed the finding has no file-deletion capability (Write/Edit only, and the stage's
 * Bash allowlist has no `rm`/`git rm`), so this file cannot be removed from disk here. It is reduced
 * to this placeholder — no assertions about StageDispatcher behavior remain — so a future stage that
 * can delete files removes it outright, and the testing stage adds real coverage under its own name.
 */
describe.skip('stage.dispatcher.dependencies placeholder (pending file deletion)', () => {
    it('is not real coverage — see file comment', () => {});
});
