import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@maroonedsoftware/logger';
import type { AgentRunInput, AgentRunOutput } from '#modules/agent/stage.agent.js';
import type { ReviewEvalCase } from '#modules/evals/review.eval.corpus.js';
import { runCase, seedCase, type SeededCase } from '#modules/evals/review.eval.run.js';
import { rawView, verifiedView } from '#modules/evals/review.eval.score.js';
import { findStage, parseStages } from '#modules/stages/stage.config.js';

const exec = promisify(execFile);

const STAGES = `
stages:
  - name: review
    mode: agent
    worktree: readonly
    adapter: cli
    model: test-model
    worktreeFrom: branch
    instructions: Review it.
    onPass: done
    onFail: review
    maxKickbacks: 1
`;

/**
 * The runner's own wiring, with a real scratch repository and verifier and only the model faked: the
 * part of a measurement that can be wrong without spending anything.
 */
describe('seedCase and runCase', () => {
    const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
    const stages = parseStages(STAGES);
    const stage = findStage(stages, 'review');
    let source: string;
    let base: string;
    let evalCase: ReviewEvalCase;
    let seeded: SeededCase | undefined;

    const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec('git', args, { cwd })).stdout.trim();

    beforeEach(async () => {
        source = await mkdtemp(join(tmpdir(), 'review-eval-source-'));
        await git(source, 'init', '-q', '-b', 'main');
        await git(source, 'config', 'user.email', 'test@example.com');
        await git(source, 'config', 'user.name', 'Test');
        await writeFile(join(source, 'kept.ts'), 'export const kept = 1;\n');
        await git(source, 'add', '-A');
        await git(source, 'commit', '-q', '-m', 'first, with a message nothing should see');
        await writeFile(join(source, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
        await git(source, 'add', '-A');
        await git(source, 'commit', '-q', '-m', 'second');
        base = await git(source, 'rev-parse', 'HEAD');

        const patchPath = join(source, '..', `${source.split('/').pop()}.patch`);
        const patch = [
            'diff --git a/a.ts b/a.ts',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1,2 +1,3 @@',
            ' export const a = 1;',
            '+export const c = 3;',
            ' export const b = 2;',
            '',
        ].join('\n');
        await writeFile(patchPath, patch);
        evalCase = {
            id: 'some-revealing-name',
            base,
            source: base,
            title: 'Add c',
            plan: '## Goal\n\nAdd c.\n\n## Files in scope\n\n- a.ts\n',
            patchPath,
            patch,
            truth: { kind: 'defect', class: 'logic', file: 'a.ts', lines: [2, 2], about: 'c is wrong', fixedBy: 'f'.repeat(40) },
        };
    });

    afterEach(async () => {
        await seeded?.remove();
        seeded = undefined;
        await rm(source, { recursive: true, force: true });
        await rm(evalCase.patchPath, { force: true });
    });

    const agentReturning = (output: Partial<AgentRunOutput>, seen?: { input?: AgentRunInput }) => ({
        run: async (input: AgentRunInput): Promise<AgentRunOutput> => {
            if (seen) seen.input = input;
            return { truncated: false, ...output } as AgentRunOutput;
        },
    });

    it('seeds one commit of history with the patch on a card branch, and nothing to identify the case', async () => {
        seeded = await seedCase(evalCase, { sourceRepo: source, ordinal: 7, logger });
        const { path, baseSha, branch } = seeded.worktree;

        expect(await git(path, 'rev-list', '--count', baseSha)).toBe('1');
        expect(await git(path, 'log', '--format=%s', `${baseSha}..HEAD`)).toBe('Add c');
        expect(await git(path, 'diff', '--name-only', baseSha)).toBe('a.ts');
        expect(await git(path, 'log', '--all', '--format=%s')).not.toContain('nothing should see');
        expect(await git(path, 'status', '--porcelain')).toBe('');
        expect(branch).toBe('card/0007');
        expect(seeded.cardId).toBe('0007');
        expect(existsSync(join(path, 'truth.json'))).toBe(false);
        expect(path).not.toContain(evalCase.id);
    });

    it('keeps the base\'s file modes and does not count a later mode change as an edit', async () => {
        await chmod(join(source, 'kept.ts'), 0o755);
        await git(source, 'add', '-A');
        await git(source, 'commit', '-q', '-m', 'an executable file');
        seeded = await seedCase({ ...evalCase, base: await git(source, 'rev-parse', 'HEAD') }, { sourceRepo: source, ordinal: 1, logger });
        const { path, baseSha } = seeded.worktree;
        expect(await git(path, 'ls-tree', baseSha, 'kept.ts')).toMatch(/^100755/);
        expect(await git(path, 'ls-tree', baseSha, 'a.ts')).toMatch(/^100644/);

        // What a first `pnpm install` does to a package's `bin`.
        await chmod(join(path, 'a.ts'), 0o755);

        expect(await seeded.worktrees.uncommittedPaths(seeded.worktree)).toEqual([]);
    });

    it('removes the scratch directory', async () => {
        const local = await seedCase(evalCase, { sourceRepo: source, ordinal: 1, logger });
        await local.remove();
        expect(existsSync(local.root)).toBe(false);
    });

    it('gives the agent the plan and the base, and leaves the truth out of the plan', async () => {
        seeded = await seedCase(evalCase, { sourceRepo: source, ordinal: 1, logger });
        const seen: { input?: AgentRunInput } = {};
        const reported = { summary: 's', verdict: 'pass', findings: [], criteria: [] };

        const run = await runCase({ evalCase, seeded, stage, stages, agent: agentReturning({ result: reported }, seen), logger });

        const input = seen.input!;
        expect(input.baseSha).toBe(seeded.worktree.baseSha);
        expect(input.context.worktreeRoot).toBe(seeded.worktree.path);
        const plan = await readFile(input.planPath, 'utf8');
        expect(plan).toContain('Add c.');
        expect(plan).not.toContain('c is wrong');
        expect(plan).not.toContain(evalCase.id);
        expect(run.verification).toMatchObject({ passed: true, changedPaths: ['a.ts'] });
        expect(run.unscored).toBeUndefined();
    });

    it('runs the real verifier, whose refusal the verified view honours and the raw view does not', async () => {
        seeded = await seedCase(evalCase, { sourceRepo: source, ordinal: 1, logger });
        const hallucinated = {
            summary: 's',
            verdict: 'revise',
            findings: [{ severity: 'blocker', kind: 'defect', file: 'nowhere.ts', line: 1, problem: 'p', suggestion: 's' }],
        };

        const run = await runCase({ evalCase, seeded, stage, stages, agent: agentReturning({ result: hallucinated }), logger });

        expect(run.verification?.passed).toBe(false);
        expect(rawView(run.reported).findings).toHaveLength(1);
        expect(verifiedView(run.reported, run.verification).rejected).toBe(true);
    });

    // The verifier says this only in a log line, so `verifiedView` repeats its rule. This pins the two together.
    it('agrees with the real verifier that a defect on an unchanged file passes, relabelled', async () => {
        seeded = await seedCase(evalCase, { sourceRepo: source, ordinal: 1, logger });
        const outside = {
            summary: 's',
            verdict: 'revise',
            findings: [{ severity: 'blocker', kind: 'defect', file: 'kept.ts', line: 1, problem: 'p', suggestion: 's' }],
        };

        const run = await runCase({ evalCase, seeded, stage, stages, agent: agentReturning({ result: outside }), logger });

        expect(run.verification?.passed).toBe(true);
        expect(verifiedView(run.reported, run.verification).findings[0]?.kind).toBe('omission');
    });

    it('turns an engine that throws into an unscored run, so earlier results survive', async () => {
        seeded = await seedCase(evalCase, { sourceRepo: source, ordinal: 1, logger });
        const agent = {
            run: async (): Promise<AgentRunOutput> => {
                throw new Error('engine went away');
            },
        };

        const run = await runCase({ evalCase, seeded, stage, stages, agent, logger });

        expect(run.unscored).toBe('the engine threw: engine went away');
    });

    it('marks a run that hit the usage limit, so the runner can stop', async () => {
        seeded = await seedCase(evalCase, { sourceRepo: source, ordinal: 1, logger });
        const usageLimit = { resetsAt: Date.now() } as unknown as AgentRunOutput['usageLimit'];

        const run = await runCase({ evalCase, seeded, stage, stages, agent: agentReturning({ usageLimit }), logger });

        expect(run.outOfUsage).toBe(true);
        expect(run.unscored).toContain('usage limit');
    });

    it('leaves a run that stopped short out of the score, saying why', async () => {
        seeded = await seedCase(evalCase, { sourceRepo: source, ordinal: 1, logger });
        const cases: [Partial<AgentRunOutput>, string][] = [
            [{ engineFailure: 'engine went away' }, 'engine went away'],
            [{ budgetFailure: 'over budget' }, 'over budget'],
            [{ truncated: true, result: { summary: 's', verdict: 'pass', findings: [] } }, 'ran out of steps'],
            [{}, 'never reported'],
        ];
        for (const [output, reason] of cases) {
            const run = await runCase({ evalCase, seeded, stage, stages, agent: agentReturning(output), logger });
            expect(run.unscored).toContain(reason);
            expect(run.verification).toBeUndefined();
        }
    });
});
