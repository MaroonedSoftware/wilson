import { defineProject } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineProject({
    oxc: false,
    test: {
        globals: true,
        include: ['./tests/**/*.test.ts'],
        environment: 'node',
        testTimeout: 30000,
        pool: 'forks',
        alias: {
            '#src': new URL('./src/', import.meta.url).pathname,
            '#modules': new URL('./src/modules/', import.meta.url).pathname,
            '#shared': new URL('./src/shared/', import.meta.url).pathname,
            '#tests': new URL('./tests/', import.meta.url).pathname,
        },
    },
    plugins: [swc.vite()],
});
