import { defineProject } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineProject({
    oxc: false,
    test: {
        globals: true,
        include: ['./tests/**/*.test.ts'],
        environment: 'node',
        testTimeout: 30000,
        // A file that writes accounts queues in `beforeAll` for `holdAccounts`' lock, behind every
        // other such file, and vitest counts that wait against this.
        hookTimeout: 120000,
        pool: 'forks',
        globalSetup: ['./tests/support/test.db.migrate.ts'],
        // The CLI command tests under tests/cli import packages/cli's source; see that file.
        setupFiles: ['../../packages/cli/tests/support/no.keyring.setup.ts'],
        alias: {
            '#src': new URL('./src/', import.meta.url).pathname,
            '#modules': new URL('./src/modules/', import.meta.url).pathname,
            '#shared': new URL('./src/shared/', import.meta.url).pathname,
            '#tests': new URL('./tests/', import.meta.url).pathname,
        },
    },
    plugins: [swc.vite()],
});
