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
 *
 * maxWorkers is capped at half the machine's CPUs. Every card stage runs this whole command, and
 * at a `card-stage-concurrency` of 2 the box was carrying two unbounded suites at once (plus the
 * daemon and two agents), each free to claim every core. Card 0261's rerun-once logic recorded
 * four `test.flaky` events on 2026-09-20 while that was happening: 17 tests at 16:22 (card 0262's
 * merge check), one at 18:41 (card 0264's merge check), eight at 20:20 (card 0269's testing
 * stage) and three at 20:40 (card 0265's testing stage) — 29 instances across 12 files, 27 of
 * them in apps/web/tests. Every occurrence happened while two full root suites ran at once. Card
 * 0251 already raised timeouts for this exact symptom a day earlier (asyncUtilTimeout is 5000ms
 * in apps/web/tests/setup.ts, testTimeout is 10000ms in apps/web/vitest.config.ts) and the flakes
 * above all postdate that change, so a third raise would buy less and hide more; the fix is to
 * stop one suite run from taking the whole machine. Cost: recent testing stages finish in roughly
 * 10 minutes against a 45-minute maxWallClockMs (2700000ms), so there is headroom, but halving
 * worker parallelism spends some of it and a run should be expected to take longer than before.
 *
 * This one worker pool is shared across every project in the `projects` list above, so the bound
 * here already covers apps/web (where 27 of the 29 instances happened); apps/web/vitest.config.ts
 * needs no bound of its own.
 */
export default defineConfig({
    test: {
        projects: ['apps/api', 'apps/web', 'packages/cli'],
        maxWorkers: '50%',
    },
});
