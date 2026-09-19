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

describe('apps/web/vitest.config.ts', () => {
    it('sets testTimeout comfortably above the 5000ms asyncUtilTimeout from tests/setup.ts', () => {
        expect(webConfig.test?.testTimeout).toBe(10000);
    });

    it('keeps tests/setup.ts registered as a setupFile', () => {
        expect(webConfig.test?.setupFiles).toContain('./tests/setup.ts');
    });
});
