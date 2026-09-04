import { defineProject } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * Card 0231. `apps/api/vitest.config.ts`'s `include` only ever matches `*.test.ts`, so
 * `cli.engine.contract.probe.ts` (`apps/api/tests/modules/agent/`) is invisible to it and to the
 * root `vitest.config.mts` that the `testing` stage's verifier reads — the default `pnpm test`
 * collects nothing new, not a skip. This config names that one file directly and is reached only
 * through the `test:engine` script (`apps/api/package.json`), which an operator runs by hand.
 *
 * Otherwise identical to `vitest.config.ts` — same aliases, same pool — because the probes import
 * the same `#modules`/`#src` sources and need the same test environment; only `include` differs.
 */
export default defineProject({
    oxc: false,
    test: {
        globals: true,
        include: ['./tests/**/*.probe.ts'],
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
