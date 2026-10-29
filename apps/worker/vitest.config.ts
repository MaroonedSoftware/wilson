import { defineProject } from 'vitest/config';

// Tests live in apps/worker/tests/, mirroring src/, as every other package's do.
export default defineProject({
    test: {
        include: ['./tests/**/*.test.ts'],
        environment: 'node',
    },
});
