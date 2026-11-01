// Card 0251: `apps/web/vitest.config.ts` sets `testTimeout: 10000` for the web project so
// vitest's own per-test timeout can't race Testing Library's `asyncUtilTimeout` (5000ms, set by
// `tests/setup.ts` via `test.setupFiles`). Review of this card reproduced that race directly: a
// slow `findBy*`/`waitFor` under full-suite load got cut off by vitest's *unconfigured* 5000ms
// default `testTimeout` before Testing Library's own wait could resolve or fail it on its own
// terms (`apps/web/tests/planning-session.test.ts`, then `board.dnd.test.ts`,
// `board.reorder.test.ts` and `card-detail.actions.test.ts`, each in a large batch). This checks
// the two numbers directly, on the actual config object vitest resolves this project from, so the
// margin between them can't silently erode back to nothing.
import { describe, expect, it } from 'vitest';
import webConfig from '../vitest.config';
import rootConfig from '../../../vitest.config.mjs';

describe('apps/web/vitest.config.ts', () => {
    it('sets testTimeout comfortably above the 5000ms asyncUtilTimeout from tests/setup.ts', () => {
        expect(webConfig.test?.testTimeout).toBe(10000);
    });

    it('keeps tests/setup.ts registered as a setupFile', () => {
        expect(webConfig.test?.setupFiles).toContain('./tests/setup.ts');
    });
});

// Card 0270: two full root suites (`pnpm exec vitest run`, covering apps/api, apps/web and
// packages/cli) running at once produced four `test.flaky` events on 2026-09-20 — 29 instances
// across 12 files, 27 of them in apps/web/tests — because the root runner left its worker pool
// unbounded and let each run claim every core. Raising timeouts was already tried for this exact
// symptom by card 0251 a day earlier and the flakes above postdate it, so this checks the actual
// lever instead: the resolved root config object vitest builds this whole suite from.
describe('vitest.config.mts (root)', () => {
    it('bounds maxWorkers to a share of the CPU count, not a fixed number of threads', () => {
        // A fixed thread count (e.g. 4) would not scale with the machine and would not address
        // "one suite claims every core" on boxes of a different size than the one that flaked.
        expect(typeof rootConfig.test?.maxWorkers).toBe('string');
        expect(String(rootConfig.test?.maxWorkers)).toMatch(/^\d+%$/);
    });

    it('keeps every package with tests in one root run so the testing verifier reads one report', () => {
        expect(rootConfig.test?.projects).toEqual(['apps/api', 'apps/web', 'apps/worker', 'packages/cli', 'packages/worker-protocol']);
    });
});
