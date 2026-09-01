import { defineConfig } from 'vitest/config';

/**
 * The root runner, so one command covers every package that has tests and writes one JSON report.
 *
 * The testing stage's verifier reads a single report file and compares counts against the
 * pre-change tree (apps/api/src/modules/stages/test.report.ts). Running each package separately
 * would give it one report per package and nothing to compare.
 *
 * Projects are listed explicitly rather than globbed: `packages/config-*` have no test setup, and
 * a glob would sweep them in.
 */
export default defineConfig({
    test: {
        projects: ['apps/api', 'apps/web', 'packages/cli'],
    },
});
