import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Logger } from '@maroonedsoftware/logger';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import type { AgentRunOutput, StageAgent } from '#modules/agent/stage.agent.js';
import type { ToolContext } from '#modules/agent/tools/index.js';
import { StaticBoardConfig } from '#modules/board/board.config.js';
import { sectionsOf, type Card } from '#modules/board/card.js';
import { computeReviewEvidence } from '#modules/stages/review.evidence.js';
import { ReviewVerifier } from '#modules/stages/review.verifier.js';
import type { ProjectStages, StageConfig } from '#modules/stages/stage.config.js';
import { planMaterial } from '#modules/stages/stage.preparation.js';
import { ReviewResultSchema } from '#modules/stages/stage.result.js';
import { WorktreeManager, worktreeHost, type Worktree } from '#modules/worktree/worktree.manager.js';
import type { ReviewEvalCase } from './review.eval.corpus.js';
import type { ReviewEvalRun } from './review.eval.score.js';

const exec = promisify(execFile);

/** A project name nothing else uses. It reaches only the duck-typed event log below. */
const EVAL_PROJECT = 'review-eval';

/**
 * Tool calls report here, and with no board there is nowhere for them to go. `CliStageAgent` and the
 * tools only ever append.
 */
const discardedEvents = { append: async () => {} } as unknown as ToolContext['events'];

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A case that an error stopped, which says nothing about the review and must not cost the other cases. */
export const failedRun = (evalCase: ReviewEvalCase, what: string, err: unknown): ReviewEvalRun => ({
    caseId: evalCase.id,
    truth: evalCase.truth,
    unscored: `${what}: ${messageOf(err)}`,
});

export interface SeededCase {
    /** Scratch directory holding the repository, its worktree and the run root. */
    root: string;
    cardId: string;
    card: Card;
    worktree: Worktree;
    worktrees: WorktreeManager;
    runRoot: string;
    remove: () => Promise<void>;
}

/**
 * A scratch repository for one case: the base's tree as a single commit, with the patch committed on
 * a card branch. There is no history to read and nothing from the corpus inside it. The card's id is
 * only a position, so nothing the reviewer can see says which case it is on.
 */
export const seedCase = async (evalCase: ReviewEvalCase, options: { sourceRepo: string; ordinal: number; logger: Logger }): Promise<SeededCase> => {
    const root = await mkdtemp(join(tmpdir(), 'wilson-review-eval-'));
    const remove = (): Promise<void> => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    try {
        const code = join(root, 'code');
        const tarball = join(root, 'base.tar');
        await mkdir(code);
        await exec('git', ['-C', options.sourceRepo, 'archive', '--format=tar', '-o', tarball, evalCase.base]);
        await exec('tar', ['-xf', tarball, '-C', code]);
        await rm(tarball);

        const inCode = (args: string[], cwd = code): Promise<unknown> => exec('git', args, { cwd, maxBuffer: 1 << 28 });
        await inCode(['init', '-q', '-b', 'main']);
        await inCode(['config', 'user.email', 'reviewer@example.com']);
        await inCode(['config', 'user.name', 'Reviewer']);
        await inCode(['config', 'commit.gpgsign', 'false']);
        // Background maintenance would still be writing here when the directory is removed.
        await inCode(['config', 'gc.auto', '0']);
        await inCode(['config', 'maintenance.auto', 'false']);
        // `-f` because the tree is what was committed, whatever its ignore files say.
        await inCode(['add', '-A', '-f']);
        await inCode(['commit', '-q', '--no-verify', '-m', 'Initial commit']);
        // A first install marks a package's `bin` executable. An old base may have that file as 644, and
        // a reviewer that ran `pnpm` has not edited it. Set after the commit, which keeps the base's modes.
        await inCode(['config', 'core.fileMode', 'false']);

        const runRoot = join(root, 'run');
        const worktrees = new WorktreeManager(new StaticBoardConfig(EVAL_PROJECT, code, join(root, 'worktrees'), runRoot), options.logger);
        const cardId = String(options.ordinal).padStart(4, '0');
        const worktree = await worktrees.create(cardId, `card/${cardId}`);
        await inCode(['apply', '--index', evalCase.patchPath], worktree.path);
        await inCode(['commit', '-q', '--no-verify', '-m', evalCase.title], worktree.path);

        const card: Card = {
            frontmatter: { id: cardId, title: evalCase.title, stage: 'review', dependsOn: [], retries: {} },
            sections: sectionsOf(evalCase.plan),
            body: evalCase.plan,
        };
        return { root, cardId, card, worktree, worktrees, runRoot, remove };
    } catch (err) {
        await remove();
        throw err;
    }
};

export interface RunCaseInput {
    evalCase: ReviewEvalCase;
    seeded: SeededCase;
    stage: StageConfig;
    stages: ProjectStages;
    agent: Pick<StageAgent, 'run'>;
    logger: Logger;
}

/**
 * One review of one case, wired the way `StageDispatcher.runAgent` wires it, for the parts that can
 * run with no board: the same plan file, unwired-symbol evidence, scope guard, adapter and verifier.
 * Type-check evidence is left out because a scratch repository has no dependencies installed.
 */
export const runCase = async ({ evalCase, seeded, stage, stages, agent, logger }: RunCaseInput): Promise<ReviewEvalRun> => {
    const { worktree, worktrees, card, cardId, runRoot } = seeded;
    const startedAt = Date.now();

    const planDir = join(runRoot, 'cards', cardId);
    const planPath = join(planDir, 'plan.md');
    try {
        const evidence = await computeReviewEvidence(
            { worktrees, logger, runRoot },
            { cardId, worktree, stage: { ...stage, typecheckCommand: undefined } },
        );
        await mkdir(planDir, { recursive: true });
        await writeFile(planPath, planMaterial(card, stages, stage, evidence.markdown), 'utf8');
    } catch (err) {
        return { ...failedRun(evalCase, 'the case could not be set up', err), durationMs: Date.now() - startedAt };
    }

    const scope = new ScopeGuard({
        worktreeRoot: worktree.path,
        allow: stage.extraScope,
        alwaysAllowed: stages.alwaysAllowed,
        deny: stages.deny,
        readableExtras: [planPath],
        host: worktreeHost(worktree),
    });
    const context: ToolContext = {
        project: EVAL_PROJECT,
        cardId,
        stage: stage.name,
        worktreeRoot: worktree.path,
        scope,
        commands: new CommandAllowlist(stage.allowedCommands),
        scopeViolationPolicy: stage.scopeViolation ?? stages.scopeViolation,
        host: worktreeHost(worktree),
        events: discardedEvents,
        logger,
    };

    let run: AgentRunOutput;
    try {
        run = await agent.run({
            stage,
            context,
            planPath,
            title: card.frontmatter.title,
            resultSchema: ReviewResultSchema,
            baseSha: worktree.baseSha,
        });
    } catch (err) {
        return { ...failedRun(evalCase, 'the engine threw', err), durationMs: Date.now() - startedAt };
    }
    const base = { caseId: evalCase.id, truth: evalCase.truth, durationMs: Date.now() - startedAt, ...(run.usage && { usage: run.usage }) };

    const stopped =
        run.budgetFailure ??
        run.engineFailure ??
        run.loopFailure ??
        (run.usageLimit && 'the account hit a usage limit') ??
        (run.interrupted && 'the run was interrupted') ??
        (run.blocked && `the stage asked a question: ${run.blocked.question}`) ??
        (run.truncated ? 'the stage ran out of steps' : undefined) ??
        (run.result === undefined ? 'the stage never reported a result' : undefined);
    if (stopped) return { ...base, reported: run.result, unscored: stopped, ...(run.usageLimit && { outOfUsage: true }) };

    try {
        const verification = await new ReviewVerifier(worktrees, logger).verify({ worktree, scope, stage, cardId, card, result: run.result });
        return {
            ...base,
            reported: run.result,
            verification: { passed: verification.passed, failures: verification.failures, changedPaths: verification.changedPaths },
        };
    } catch (err) {
        // The review is already paid for, so its result and usage stay in the record.
        return { ...base, ...failedRun(evalCase, 'the verifier threw', err), reported: run.result };
    }
};
