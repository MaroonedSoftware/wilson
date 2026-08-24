import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { withFindings } from '#modules/board/append.findings.js';
import { filesInScope, type Card } from '#modules/board/card.js';
import { serializeCard } from '#modules/board/card.parser.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { REPORT_TOOL, ScopeKickbackError, type ToolContext } from '#modules/agent/tools/index.js';
import { StageAgentMap } from '#modules/agent/stage.agent.js';
import { EventLog } from '#modules/events/event.log.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { kickback, shouldAdvance } from './kickback.js';
import { runConfiguredCommand } from './run.command.js';
import { findStage, loadStages, type StageConfig } from './stage.config.js';
import { StageResultSchemaMap, type ReviewFinding, type StageOutcome } from './stage.result.js';
import { StageVerifierMap } from './stage.verifier.js';

/** The stage's own summary, for the commit message body. */
const describe = (result: unknown): string => {
    const summary = (result as { summary?: string } | undefined)?.summary;
    return summary && summary.trim().length > 0 ? summary.trim() : 'No summary reported.';
};

/** The findings a review carries, when its result carries any. Other stages report none. */
const findingsFrom = (result: unknown): ReviewFinding[] | undefined => {
    const findings = (result as { findings?: unknown } | undefined)?.findings;
    return Array.isArray(findings) ? (findings as ReviewFinding[]) : undefined;
};

/**
 * Run one stage for one card.
 *
 * Takes a stage config object even though exactly one stage is configured, because that is the seam
 * that keeps "stages are config, not code" true when the testing stage lands as card one.
 *
 * The runner is the sole writer of transitions (PROJECT.md decision 5): an agent stage that
 * finishes moves the card itself, forward on a pass or back on a kickback. A `manual` stage is a
 * human gate the runner leaves alone.
 */
@Injectable()
export class StageDispatcher {
    constructor(
        private readonly config: BoardConfig,
        private readonly board: BoardRepository,
        private readonly worktrees: WorktreeManager,
        private readonly agents: StageAgentMap,
        private readonly verifiers: StageVerifierMap,
        private readonly resultSchemas: StageResultSchemaMap,
        private readonly events: EventLog,
        private readonly logger: Logger,
    ) {}

    async run(cardId: string, stageName: string): Promise<StageOutcome> {
        const stages = await loadStages(this.config.boardRoot);
        const stage = findStage(stages, stageName);

        // Read the card at its approved sha, not at HEAD: an edit landing on the board while this
        // stage runs must not change the contract underneath it.
        const head = await this.board.read(cardId);
        const pinnedSha = head.frontmatter.planSha;
        const card = pinnedSha ? await this.board.readAt(cardId, pinnedSha) : head;
        if (!pinnedSha) {
            this.logger.warn(`card ${cardId} has no planSha; running against the working copy of the plan`);
        }

        this.assertDispatchable(card, stage);

        const branch = this.worktrees.branchName(cardId, card.frontmatter.title);

        // `base` means "start fresh if there is nothing to resume", not "always discard". A card
        // kicked back from review carries findings citing file:line on its own branch; rebuilding
        // from scratch throws away the work those findings are about, and any tests a later stage
        // already wrote. Since only a passing stage commits, a branch carrying work is by
        // construction the last state that satisfied an exit condition, so resuming is always safe.
        const resumable = stage.worktreeFrom === 'branch' || (await this.worktrees.hasWork(branch));
        let worktree = resumable ? await this.worktrees.resume(cardId, branch) : await this.worktrees.create(cardId, branch);

        // A resumed branch may be many merges behind. Left alone the stage implements against a tree
        // that no longer matches main, and neither its exit condition nor the review can distinguish
        // "this does not exist" from "this does not exist here".
        if (resumable) {
            const rebased = await this.worktrees.rebaseOntoHead(worktree);
            if (!rebased.ok) {
                throw new Error(`card ${cardId} cannot be brought up to date: ${rebased.reason}`);
            }
            worktree = { ...worktree, baseSha: rebased.baseSha };
        }
        await this.events.append({
            project: this.config.project,
            cardId,
            stage: stageName,
            type: 'worktree.created',
            payload: { branch, baseSha: worktree.baseSha, path: worktree.path },
        });

        // Before the agent sees the tree, not as its first task: a fresh worktree has no
        // node_modules, and card 0001 twice spent its whole run installing dependencies and
        // confirming the baseline built, then reported that as the work.
        if (stage.setupCommand) {
            const failure = await runConfiguredCommand(worktree.path, stage.setupCommand);
            await this.events.append({
                project: this.config.project,
                cardId,
                stage: stageName,
                type: 'worktree.prepared',
                payload: { command: stage.setupCommand, ok: !failure, ...(failure ? { reason: failure.reason } : {}) },
            });
            if (failure) {
                // An unprepared worktree makes every later signal meaningless — the build would fail
                // for reasons that have nothing to do with the card.
                throw new Error(`worktree setup failed for ${cardId}: ${failure.reason}`);
            }
            this.logger.info(`worktree prepared with \`${stage.setupCommand}\``);
        }

        const planPath = await this.materializePlan(card, pinnedSha);

        const scope = new ScopeGuard({
            worktreeRoot: worktree.path,
            allow: [...filesInScope(card), ...stage.extraScope],
            alwaysAllowed: stages.alwaysAllowed,
            deny: stages.deny,
            // The plan lives outside the worktree so it cannot be committed to the card's branch.
            // Without this it is also unreadable, and the agent infers its own contract.
            readableExtras: [planPath],
        });

        await this.events.append({
            project: this.config.project,
            cardId,
            stage: stageName,
            type: 'stage.dispatched',
            payload: { provider: stage.provider, model: stage.model, planPath, scope: filesInScope(card) },
        });

        try {
            const outcome = await this.runAgent({ card, stage, worktree, scope, planPath, stages });

            // Only a passing stage commits. A failed stage leaves its work in the worktree for
            // inspection, and the next attempt starts from the base rather than building on a tree
            // that did not satisfy its exit condition.
            if (outcome.passed) {
                const sha = await this.worktrees.commit(worktree, `${cardId}: ${stageName}\n\n${describe(outcome.result)}`);
                if (sha) {
                    await this.events.append({
                        project: this.config.project,
                        cardId,
                        stage: stageName,
                        type: 'work.committed',
                        payload: { sha, branch },
                    });
                    this.logger.info(`committed ${sha.slice(0, 8)} to ${branch}`);
                }
            }

            await this.events.append({
                project: this.config.project,
                cardId,
                stage: stageName,
                type: outcome.passed ? 'stage.passed' : 'stage.failed',
                payload: {
                    failures: outcome.failures,
                    changedPaths: outcome.changedPaths,
                    grants: outcome.scopeGrants,
                    usage: outcome.usage,
                    // The result itself, not just its shape. A review's findings *are* the output of
                    // the stage; recording only that it passed throws away the thing it produced.
                    result: outcome.result ?? null,
                },
            });

            if (stage.mode !== 'agent') {
                return outcome;
            }

            // Outside the try below, and in its own: the stage's outcome is already recorded, and a
            // transition that fails to write must not be reported as the stage having failed. Sharing
            // the catch would append a `stage.failed` event after a `stage.passed` one for the same
            // run, leaving the card's history contradicting itself about what the stage did.
            let transitionedTo: string | undefined;
            try {
                transitionedTo = await this.writeTransition(cardId, stageName, stage, card, outcome);
            } catch (err) {
                await this.events.append({
                    project: this.config.project,
                    cardId,
                    stage: stageName,
                    type: 'transition.failed',
                    payload: { error: (err as Error).message, outcome: outcome.passed ? 'passed' : 'failed' },
                });
                // Still thrown: the card is now stranded in a stage whose work is done, and a
                // silent failure here is how a card sits untouched forever.
                throw err;
            }
            return { ...outcome, transitionedTo };
        } catch (err) {
            const reason = err instanceof ScopeKickbackError ? err.message : (err as Error).message;
            await this.events.append({
                project: this.config.project,
                cardId,
                stage: stageName,
                type: 'stage.failed',
                payload: { error: reason },
            });
            throw err;
        }
    }

    /**
     * Move the card: forward on a pass, back on a kickback, and record why either way.
     *
     * The runner is the sole writer of card state (PROJECT.md decision 5) — this always goes through
     * `BoardRepository.write`, never a direct edit of the file. A failure here is not swallowed: the
     * stage's own `stage.passed`/`stage.failed` event is already recorded, but a transition that did
     * not happen must surface, so this throws rather than catching.
     */
    private async writeTransition(cardId: string, stageName: string, stage: StageConfig, card: Card, outcome: StageOutcome): Promise<string> {
        const decision = shouldAdvance(outcome.passed, outcome.result)
            ? { target: stage.onPass, retries: card.frontmatter.retries }
            : kickback(stage, card.frontmatter.retries);
        const findings = findingsFrom(outcome.result);

        await this.board.write(cardId, `${cardId}: ${stageName} -> ${decision.target}`, current => ({
            ...current,
            frontmatter: { ...current.frontmatter, stage: decision.target, retries: decision.retries },
            body: findings ? withFindings(current.body, findings) : current.body,
        }));

        await this.events.append({
            project: this.config.project,
            cardId,
            stage: stageName,
            type: 'transition.written',
            payload: { from: stageName, to: decision.target, retries: decision.retries, by: 'runner' },
        });

        return decision.target;
    }

    private assertDispatchable(card: Card, stage: StageConfig): void {
        if (card.frontmatter.stage !== stage.name) {
            throw new Error(`card ${card.frontmatter.id} is in stage "${card.frontmatter.stage}", not "${stage.name}"`);
        }
        // A hard block: file-based coordination cannot carry an in-flight API contract between two
        // running agents (PROJECT.md, dependency blocking).
        if (card.frontmatter.dependsOn.length > 0) {
            throw new Error(
                `card ${card.frontmatter.id} depends on ${card.frontmatter.dependsOn.join(', ')}; dependency checking lands with the queue at step 3`,
            );
        }
        if (filesInScope(card).length === 0) {
            throw new Error(`card ${card.frontmatter.id} has an empty "Files in scope"; nothing would be writable`);
        }
    }

    /**
     * Write the plan where the agent can read it — outside the worktree.
     *
     * The board is a sibling repo, so the plan is not in the tree the agent is editing. Materializing
     * it outside means it can never be accidentally committed to the card's branch.
     */
    private async materializePlan(card: Card, sha: string | undefined): Promise<string> {
        const dir = join(this.config.runRoot, 'cards', card.frontmatter.id);
        await mkdir(dir, { recursive: true });
        const path = join(dir, 'plan.md');
        await writeFile(path, serializeCard(card), 'utf8');
        this.logger.info(`plan for ${card.frontmatter.id} materialized at ${path}${sha ? ` (${sha.slice(0, 8)})` : ''}`);
        return path;
    }

    private async runAgent(input: {
        card: Card;
        stage: StageConfig;
        worktree: Awaited<ReturnType<WorktreeManager['create']>>;
        scope: ScopeGuard;
        planPath: string;
        stages: Awaited<ReturnType<typeof loadStages>>;
    }): Promise<StageOutcome> {
        const { card, stage, worktree, scope, planPath, stages } = input;

        const context: ToolContext = {
            project: this.config.project,
            cardId: card.frontmatter.id,
            stage: stage.name,
            worktreeRoot: worktree.path,
            scope,
            commands: new CommandAllowlist(stage.allowedCommands),
            scopeViolationPolicy: stages.scopeViolation,
            events: this.events,
            logger: this.logger,
        };

        const resultSchema = this.resultSchemas.get(stage.verifier ?? stage.name);
        if (!resultSchema) {
            throw new Error(
                `stage "${stage.name}" names verifier "${stage.verifier ?? stage.name}", which has no registered result schema (have: ${[...this.resultSchemas.keys()].join(', ')})`,
            );
        }

        const adapter = this.agents.get(stage.adapter);
        if (!adapter) {
            throw new Error(
                `stage "${stage.name}" names adapter "${stage.adapter}", which is not registered (have: ${[...this.agents.keys()].join(', ')})`,
            );
        }

        const run = await adapter.run({ stage, context, planPath, title: card.frontmatter.title, resultSchema });

        const verifier = this.verifiers.get(stage.verifier ?? stage.name);
        if (!verifier) {
            throw new Error(
                `stage "${stage.name}" names verifier "${stage.verifier ?? stage.name}", which is not registered (have: ${[...this.verifiers.keys()].join(', ')})`,
            );
        }
        const reported = run.result;
        const verification = await verifier.verify({ worktree, scope, stage, cardId: card.frontmatter.id, result: reported });
        const failures = [...verification.failures];

        // A stage that never called the report tool never said it was finished. Whatever is in the
        // tree is where it happened to stop, not what it set out to produce.
        if (reported === undefined) {
            failures.unshift(`the stage ended without calling ${REPORT_TOOL}, so it never reported finishing`);
        }

        // A loop that ran out of steps did not finish; it stopped. Card 0002 exhausted its 60 steps
        // a third of the way through its plan, emitted a placeholder result, and passed — because
        // the diff was non-empty, in scope, and built. Truncation is knowable, so it is checked.
        //
        // Only when no more specific cause is known: a wall-clock or token-budget cutoff can land
        // with `truncated: true` well before the step count is exhausted, and naming the step cap
        // there would be false — `run.budgetFailure`, pushed below, already names the real cause.
        if (run.truncated && !run.budgetFailure) {
            failures.unshift(
                `the stage used all ${stage.maxSteps} of its steps and was cut off mid-run — its work is partial whatever the diff shows`,
            );
        }

        if (run.budgetFailure) {
            failures.unshift(run.budgetFailure);
        }

        return {
            passed: failures.length === 0,
            failures,
            changedPaths: verification.changedPaths,
            scopeGrants: scope.grants(),
            result: reported,
            usage: run.usage,
        };
    }
}
