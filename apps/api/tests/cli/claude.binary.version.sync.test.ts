import { describe, expect, it } from 'vitest';
import { CLAUDE_BINARY_VERSION } from '#modules/agent/cli.engine.version.js';

/**
 * Card 0231. `apps/api/src/modules/agent/cli.engine.version.ts` and
 * `packages/cli/src/checks/claude.binary.current.ts` each carry their own copy of the same version
 * string — `packages/cli` cannot import `@wilson/api` at all (card 0085 dropped that dependency
 * entirely), so the check's own comment says to "bump both together, in the same commit" instead.
 * That instruction lives only in prose on both sides; nothing before this test actually checked that
 * a bump landing on one side also landed on the other, so the two could drift silently — exactly the
 * kind of adapter fragility this card's field survey is about — until an operator ran the gated
 * engine probes days later and saw two different numbers with no explanation.
 *
 * Reaching into `packages/cli/src/**` from an `apps/api` test by a plain relative path, with no
 * package dependency backing it, is already this codebase's own pattern for exactly this situation:
 * `apps/api/tests/cli/daemon.current.test.ts` does the same to test `packages/cli/src/checks/daemon.current.ts`
 * directly. It works because this is one monorepo checkout, not a package import — the same
 * distinction `board-view.ts`'s own "duplicated here, deliberately" comment draws.
 */
const { EXPECTED_CLAUDE_BINARY_VERSION } = await import('../../../../packages/cli/src/checks/claude.binary.current.js');

describe('the two copies of the host claude binary version constant', () => {
    it('carry the same value on both sides of the duplication', () => {
        // If this ever fails, whichever file didn't move is the wrong one — bump it to match, per
        // both files' own comments, rather than editing this expectation.
        expect(CLAUDE_BINARY_VERSION).toBe(EXPECTED_CLAUDE_BINARY_VERSION);
    });
});
