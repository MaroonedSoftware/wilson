import { defineProject } from 'vitest/config';

// Tests live in the top-level tests/ folder, mirroring src/. A dedicated config keeps the app's
// Vite plugins (router codegen, react) out of the test run.
export default defineProject({
    test: {
        include: ['./tests/**/*.test.ts'],
        environment: 'node',
        setupFiles: ['./tests/setup.ts'],
        alias: {
            '#src': new URL('./src/', import.meta.url).pathname,
            '@wilson/sdk': new URL('../../packages/sdk/src/index.ts', import.meta.url).pathname,
        },
    },
});
