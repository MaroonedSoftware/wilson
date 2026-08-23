import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { ToolLoopAgent, hasToolCall, stepCountIs } from 'ai';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { filesInScope, type Card } from '#modules/board/card.js';
import { serializeCard } from '#modules/board/card.parser.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import { compactMessages } from '#modules/agent/compact.messages.js';
import { ModelRegistry } from '#modules/agent/model.registry.js';
import { ScopeGuard } from '#modules/agent/scope.guard.js';
import { buildTools, REPORT_TOOL, ScopeKickbackError, type ToolContext } from '#modules/agent/tools/index.js';
import { EventLog } from '#modules/events/event.log.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { ImplementingVerifier } from './implementing.verifier.js';
import { runConfiguredCommand } from './run.command.js';
import { findStage, loadStages, type StageConfig } from './stage.config.js';
import { ImplementingResultSchema, type StageOutcome } from './stage.result.js';

/**
 * The agent's report, read back off the step where it called the report tool.
 *
 * Absent when the agent never reported — which is itself a signal, since a stage that did not say
 * it had finished did not finish.
 */
const reportedResult = (steps: readonly { toolCalls?: readonly { toolName: string; input?: unknown }[] }[]): unknown => {
    for (const step of [...steps].reverse()) {
        const call = step.toolCalls?.find(c => c.toolName === REPORT_TOOL);
        if (call) return call.input;
    }
    return undefined;
};

/**
 * Run one stage for one card.
 *
 * Takes a stage config object even though exactly one stage is configured, because that is the seam
 * that keeps "stages are config, not code" true when the testing stage lands as card one.
 *
 * The runner is the sole writer of transitions (PROJECT.md decision 5). This method verifies and
 * reports; it does not move the card. Step 0 leaves the transition to the human reviewing the
 * branch, which is exactly the fallback the walking skeleton is built around.
 */
@Injectable()
export class StageDispatcher {
    constructor(
        private readonly config: BoardConfig,
        private readonly board: BoardRepository,
        private readonly worktrees: WorktreeManager,
        private readonly models: ModelRegistry,
        private readonly verifier: ImplementingVerifier,
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
        const worktree = await this.worktrees.create(cardId, branch);
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
            allow: filesInScope(card),
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
            await this.events.append({
                project: this.config.project,
                cardId,
                stage: stageName,
                type: outcome.passed ? 'stage.passed' : 'stage.failed',
                payload: { failures: outcome.failures, changedPaths: outcome.changedPaths, grants: outcome.scopeGrants, usage: outcome.usage },
            });
            return outcome;
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

        const agent = new ToolLoopAgent({
            model: this.models.resolve(stage.provider, stage.model),
            instructions: stage.instructions,
            tools: buildTools(context, ImplementingResultSchema),
            ...(stage.tools ? { activeTools: stage.tools as never } : {}),
            // The loop ends when the agent says it is finished, or when it runs out of steps.
            // Two bounds on spend, because retry limits bound the loop count and not the cost.
            stopWhen: [hasToolCall(REPORT_TOOL), stepCountIs(stage.maxSteps)],
            maxOutputTokens: stage.maxOutputTokens,
            // Without this the conversation grows until the provider refuses it outright.
            prepareStep: ({ messages }) => ({ messages: compactMessages(messages) }),
        });

        const run = await agent.generate({
            prompt: [
                `Card: ${card.frontmatter.title}`,
                '',
                `Your plan is at ${planPath}. Read it with the read tool before doing anything else — pass that`,
                `path exactly as written. It is the contract for this card: its "Files in scope" is what you may`,
                `change, and its "Out of scope" is binding even where you could technically make the change.`,
                '',
                `You are working in a git worktree at ${worktree.path}. Every other tool path is relative to it.`,
                '',
                'Implement the plan, then return the structured result.',
            ].join('\n'),
        });

        const verification = await this.verifier.verify({ worktree, scope, stage });
        const failures = [...verification.failures];
        const reported = reportedResult(run.steps);

        // A stage that never called the report tool never said it was finished. Whatever is in the
        // tree is where it happened to stop, not what it set out to produce.
        if (reported === undefined) {
            failures.unshift(`the stage ended without calling ${REPORT_TOOL}, so it never reported finishing`);
        }

        // A loop that ran out of steps did not finish; it stopped. Card 0002 exhausted its 60 steps
        // a third of the way through its plan, emitted a placeholder result, and passed — because
        // the diff was non-empty, in scope, and built. Truncation is knowable, so it is checked.
        if (run.steps.length >= stage.maxSteps) {
            failures.unshift(
                `the stage used all ${stage.maxSteps} of its steps and was cut off mid-run — its work is partial whatever the diff shows`,
            );
        }

        return {
            passed: failures.length === 0,
            failures,
            changedPaths: verification.changedPaths,
            scopeGrants: scope.grants(),
            result: reported,
            usage: { inputTokens: run.usage?.inputTokens, outputTokens: run.usage?.outputTokens },
        };
    }
}
