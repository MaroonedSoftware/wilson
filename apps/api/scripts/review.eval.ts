import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import type { Logger } from '@maroonedsoftware/logger';
import { CLAUDE_BINARY_VERSION } from '#modules/agent/cli.engine.version.js';
import { CliStageAgent } from '#modules/agent/cli.stage.agent.js';
import { caseProblems, loadCorpus } from '#modules/evals/review.eval.corpus.js';
import { runCase, seedCase } from '#modules/evals/review.eval.run.js';
import { buildReport, formatReport, outputTokensSpent, type ReviewEvalRun } from '#modules/evals/review.eval.score.js';
import { findStage, parseStages } from '#modules/stages/stage.config.js';

// Scores the real review stage against apps/api/evals/review, which says how to read the result.
// Invoked from apps/api (cwd). With no --confirm-spend it only seeds every case and starts no model,
// so reading what a run would do costs nothing. It spends model usage otherwise and never runs in CI.

const { values: opts } = parseArgs({
    options: {
        snapshot: { type: 'string' },
        'prompt-revision': { type: 'string' },
        cases: { type: 'string' },
        model: { type: 'string' },
        out: { type: 'string' },
        'max-output-tokens': { type: 'string' },
        keep: { type: 'boolean', default: false },
        'confirm-spend': { type: 'boolean', default: false },
    },
});

const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
};

// Read here to refuse, so it is no input to a build and needs no place in turbo's environment.
// eslint-disable-next-line turbo/no-undeclared-env-vars
if (process.env.CI) fail('the review measurement spends model usage and does not run in CI');
const snapshotPath = opts.snapshot ?? fail('--snapshot <stage config YAML> is required: the live prompt is only in the database');
const promptRevision = opts['prompt-revision'] ?? fail('--prompt-revision <label> is required: it names what --snapshot holds');

const casesDir = resolve(process.cwd(), 'evals/review/cases');
const git = async (args: string[]): Promise<string> => (await promisify(execFile)('git', args)).stdout.trim();
const sourceRepo = await git(['rev-parse', '--show-toplevel']);

const stages = parseStages(await readFile(snapshotPath, 'utf8'), snapshotPath);
const lane = findStage(stages, 'review');
const stage = opts.model ? { ...lane, model: opts.model } : lane;
if (stage.adapter !== 'cli') fail(`the snapshot routes review to "${stage.adapter}"; this runner drives only the cli engine`);

const corpus = await loadCorpus(casesDir);
const named = opts.cases?.split(',').map(id => id.trim());
const missing = named?.filter(id => !corpus.some(evalCase => evalCase.id === id)) ?? [];
if (missing.length > 0) fail(`no such cases: ${missing.join(', ')}`);
const chosen = named ? corpus.filter(evalCase => named.includes(evalCase.id)) : corpus;
const problems = chosen.flatMap(evalCase => caseProblems(evalCase).map(problem => `${evalCase.id}: ${problem}`));
if (problems.length > 0) fail(`the corpus is not usable:\n${problems.join('\n')}`);

const quiet = {
    debug() {},
    info() {},
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
} as unknown as Logger;
const label = {
    model: stage.model ?? fail('the snapshot gives review no model'),
    engine: `${stage.adapter} ${CLAUDE_BINARY_VERSION}`,
    promptRevision,
    promptSha256: createHash('sha256').update(stage.instructions).digest('hex'),
    corpusCommit: await git(['rev-parse', 'HEAD']),
};
const spend = opts['confirm-spend'];
console.log(
    `${spend ? 'running' : 'dry run, no model started:'} ${chosen.length} cases, ${label.model} on ${label.engine}, prompt ${promptRevision}`,
);

const agent = new CliStageAgent(quiet);
const startedAt = new Date().toISOString();
const out = opts.out ?? join(tmpdir(), `wilson-review-eval-${startedAt.replaceAll(':', '-')}.json`);
const maxOutputTokens = opts['max-output-tokens'] === undefined ? undefined : Number(opts['max-output-tokens']);
if (maxOutputTokens !== undefined && !(maxOutputTokens > 0)) fail('--max-output-tokens takes a positive number');

// Written after every case, so a run stopped by anything at all keeps what it paid for.
const save = async (runs: ReviewEvalRun[]): Promise<void> => {
    await writeFile(out, `${JSON.stringify(buildReport(label, startedAt, runs), null, 2)}\n`, 'utf8');
};

const runs: ReviewEvalRun[] = [];
let stoppedEarly: string | undefined;
for (const [index, evalCase] of chosen.entries()) {
    if (spend && maxOutputTokens !== undefined && outputTokensSpent(runs) >= maxOutputTokens) {
        stoppedEarly = `stopped before ${evalCase.id}: ${outputTokensSpent(runs)} output tokens reached the ceiling of ${maxOutputTokens}`;
        break;
    }
    const seeded = await seedCase(evalCase, { sourceRepo, ordinal: index + 1, logger: quiet });
    try {
        if (!spend) {
            console.log(`  ${evalCase.id}: seeded`);
            continue;
        }
        console.log(`  ${evalCase.id}: reviewing`);
        const run = await runCase({ evalCase, seeded, stage, stages, agent, logger: quiet });
        runs.push(run);
        await save(runs);
        console.log(`  ${evalCase.id}: ${run.unscored ?? 'scored'}, ${outputTokensSpent(runs)} output tokens so far`);
        if (run.outOfUsage) {
            stoppedEarly = `stopped after ${evalCase.id}: the account ran out of usage`;
            break;
        }
    } finally {
        if (opts.keep) console.log(`  kept ${seeded.root}`);
        else await seeded.remove();
    }
}

if (spend) {
    console.log(`\n${formatReport(buildReport(label, startedAt, runs))}\nResults, with every finding: ${out}`);
    if (stoppedEarly) console.log(`\nNot every case ran, so this is partial: ${stoppedEarly}`);
}
