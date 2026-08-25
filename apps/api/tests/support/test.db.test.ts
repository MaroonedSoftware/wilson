import { describe, expect, it, vi } from 'vitest';
import { uniqueProject } from '#tests/support/test.db.js';

describe('uniqueProject', () => {
    it('never repeats across many calls from the same module', () => {
        const names = new Set(Array.from({ length: 1000 }, () => uniqueProject()));
        expect(names.size).toBe(1000);
    });

    /**
     * The bug this card fixes: `uniqueProject` used to append a module-level counter to
     * `process.pid`, but vitest gives each test file its own module registry, so the counter
     * restarted at 0 in every file rather than once per worker. Two DB-touching test files loaded
     * into the same worker each produced `test-<pid>-0` on their first call and collided on the
     * `(project, id)` primary key.
     *
     * `vi.resetModules()` followed by a fresh dynamic import reproduces exactly that: each import
     * after a reset gets its own instance of the module, the same way vitest hands two different
     * test files their own copies of `test.db.ts`. Against the old counter-based implementation
     * this fails, because both fresh instances start their counter at 0 and the first call from
     * each instance produces the identical name. Against `randomUUID()`, which has no module
     * state to reset, the two names are unrelated regardless of how many times the module has
     * been freshly instantiated.
     */
    it('does not collide across separate module instances, i.e. separate test files sharing a worker', async () => {
        vi.resetModules();
        const first = await import('#tests/support/test.db.js');
        const nameFromFirstInstance = first.uniqueProject();

        vi.resetModules();
        const second = await import('#tests/support/test.db.js');
        const nameFromSecondInstance = second.uniqueProject();

        expect(nameFromFirstInstance).not.toBe(nameFromSecondInstance);
    });
});
