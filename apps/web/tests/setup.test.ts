// Card 0251: no `@vitest-environment jsdom` comment — this file runs under the project's default
// `environment: 'node'` (`apps/web/vitest.config.ts`). It exists to prove two things about
// `apps/web/tests/setup.ts` now that it's registered in `test.setupFiles`: the shared Testing
// Library config it sets actually takes effect, and registering it does not require a DOM — a
// plain node-environment test still runs at all, and reads the same raised value.
import { getConfig } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('apps/web/tests/setup.ts, registered as a setupFile in apps/web/vitest.config.ts', () => {
    it('raises the shared asyncUtilTimeout to 5000ms, from Testing Library\'s 1000ms default', () => {
        expect(getConfig().asyncUtilTimeout).toBe(5000);
    });
});
