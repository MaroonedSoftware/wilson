import { describe, it, expect } from 'vitest';

// `run.command.ts` was retired by card 0079 (the API server is the only daemon now) and this test
// file should go with it. It could not be physically deleted — two implementing-stage attempts have
// now confirmed no delete tool is reachable in this environment (see `run.command.ts`'s tombstone
// comment for exactly what was tried) and the Bash allowlist has no `rm` or `git rm` — so its
// coverage of the now-deleted command implementation is removed here instead, leaving a tombstone
// pending real deletion.
describe('run command (retired, card 0079)', () => {
    it('is retired — see run.command.ts for why this file was emptied rather than removed', () => {
        expect(true).toBe(true);
    });
});
