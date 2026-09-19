import { defineProject } from 'vitest/config';

// Tests live in the top-level tests/ folder, mirroring src/. A dedicated config keeps the app's
// Vite plugins (router codegen, react) out of the test run.
export default defineProject({
    test: {
        include: ['./tests/**/*.test.ts'],
        environment: 'node',
        setupFiles: ['./tests/setup.ts'],
        // Card 0251: asyncUtilTimeout in tests/setup.ts is 5000ms. Vitest's own default
        // testTimeout is also 5000ms, so under real load a slow findBy*/waitFor can be cut off
        // by vitest before Testing Library's own wait resolves or fails. Give it real margin.
        testTimeout: 10000,
        alias: {
            '#src': new URL('./src/', import.meta.url).pathname,
            '@wilson/sdk': new URL('../../packages/sdk/src/index.ts', import.meta.url).pathname,
        },
    },
});
