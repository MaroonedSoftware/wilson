import { describe, it, expect } from 'vitest';

// Same rationale as run.command.test.ts: `run.command.ts` was retired by card 0079 and this file's
// abandoned-shutdown-reporting coverage went with it. Not physically deleted because no delete tool
// is reachable in this environment, confirmed again in this stage — see run.command.ts's tombstone
// comment for exactly what was tried.
describe('run command — abandoned shutdown reporting (retired, card 0079)', () => {
    it('is retired — see run.command.ts for why this file was emptied rather than removed', () => {
        expect(true).toBe(true);
    });
});
