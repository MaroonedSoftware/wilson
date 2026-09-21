import { describe, expect, it, vi } from 'vitest';
import { testDbConnection, uniqueProject } from '#tests/support/test.db.js';

/**
 * Card 0273 pulled the five `TEST_DATABASE_*` values `testDb()` used to read inline out into this
 * function, specifically so `test.db.migrate.ts`'s `globalSetup` could read the exact same values
 * and never disagree with `testDb()` about which database it migrated. Test the resolution
 * directly, the same way `uniqueProject` is tested directly above: through the accessor both
 * callers share, not by re-deriving what it should return.
 */
describe('testDbConnection', () => {
    const keys = ['TEST_DATABASE_HOST', 'TEST_DATABASE_PORT', 'TEST_DATABASE_USER', 'TEST_DATABASE_PASSWORD', 'TEST_DATABASE_NAME'] as const;

    const withEnv = (values: Partial<Record<(typeof keys)[number], string>>, run: () => void): void => {
        const originals = Object.fromEntries(keys.map(key => [key, process.env[key]]));
        try {
            for (const key of keys) {
                if (values[key] === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = values[key];
                }
            }
            run();
        } finally {
            for (const key of keys) {
                if (originals[key] === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = originals[key];
                }
            }
        }
    };

    it('defaults to the db-test service in docker-compose.yml when nothing is set', () => {
        withEnv({}, () => {
            expect(testDbConnection()).toEqual({
                host: 'localhost',
                port: 15533,
                user: 'postgres',
                password: 'postgres',
                database: 'wilson_test',
            });
        });
    });

    it('reads every value from its TEST_DATABASE_* override, port coerced to a number', () => {
        withEnv(
            {
                TEST_DATABASE_HOST: '127.0.0.1',
                TEST_DATABASE_PORT: '25533',
                TEST_DATABASE_USER: 'someone',
                TEST_DATABASE_PASSWORD: 'secret',
                TEST_DATABASE_NAME: 'other_db',
            },
            () => {
                expect(testDbConnection()).toEqual({
                    host: '127.0.0.1',
                    port: 25533,
                    user: 'someone',
                    password: 'secret',
                    database: 'other_db',
                });
            },
        );
    });
});

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
