import { defineProject } from 'vitest/config';

// Tests live in packages/cli/tests/, mirroring src/ — the same layout apps/api and apps/web use.
export default defineProject({
    test: {
        include: ['./tests/**/*.test.ts'],
        environment: 'node',
        setupFiles: ['./tests/support/no.keyring.setup.ts'],
        alias: {
            '#src': new URL('./src/', import.meta.url).pathname,
        },
    },
});
