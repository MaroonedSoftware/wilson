import type { Logger } from '@maroonedsoftware/logger';
import { budgetedInputTokens } from '#modules/agent/budget.js';
import { CommandAllowlist } from '#modules/agent/command.allowlist.js';
import type { ScopeGuard } from '#modules/agent/scope.guard.js';
import type { StageAgentMap } from '#modules/agent/stage.agent.js';
import { StageHeldError, StageInterruptedError, type InterruptedAttempt } from '#modules/agent/stage.interrupt.js';
import { REPORT_TOOL, type ToolContext } from '#modules/agent/tools/index.js';
import type { Card } from '#modules/board/card.js';
import type { EventLog } from '#modules/events/event.log.js';
import { worktreeHost, type Worktree, type WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { withinCardBudget, withinInterruptedBudget } from './card.budget.js';
import type { ProjectStages, StageConfig } from './stage.config.js';
import type { StageResultSchemaMap, StageOutcome } from './stage.result.js';
import type { StageVerifierMap } from './stage.verifier.js';

/** What running and judging a stage needs, whoever is asking: a card's dispatch or an eval. */
export interface StageExecutionDeps {
    project: string;
    worktrees: Pick<WorktreeManager, 'uncommittedSnapshot'>;
    agents: StageAgentMap;
    verifiers: StageVerifierMap;
    resultSchemas: StageResultSchemaMap;
    events: EventLog;
    logger: Logger;
}

/** One stage's run, on a tree already cut and prepared. */
export interface StageExecutionInput {
    card: Card;
    stage: StageConfig;
    worktree: Worktree;
    scope: ScopeGuard;
    planPath: string;
    /** Set only when the project's learnings document is non-empty — see `materializeLearnings`. */
    learningsPath?: string;
    stages: ProjectStages;
    /** `run`'s allocated dev server port for this worktree (card 0027), or `undefined` when no range is configured. */
    port?: number;
    /** The attempt whose tree this run reopened, to continue from where it stopped. */
    interrupted?: InterruptedAttempt;
}

/**
 * Run a stage's agent on a prepared tree and judge what came back, without recording an outcome or
 * moving anything. The caller decides what the outcome means: `StageDispatcher` commits and writes a
 * transition, and an eval only keeps the score. The verifier is the same either way, which is what
 * makes an eval's result mean what a real stage's does.
 *
 * Throws `StageInterruptedError` or `StageHeldError` when the run stopped for a reason that says
 * nothing about the work.
 */
export const executeStage = async (deps: StageExecutionDeps, input: StageExecutionInput): Promise<StageOutcome> => {
    const { card, stage, worktree, scope, planPath, learningsPath, stages, port, interrupted } = input;

    const context: ToolContext = {
        project: deps.project,
        cardId: card.frontmatter.id,
        stage: stage.name,
        worktreeRoot: worktree.path,
        scope,
        commands: new CommandAllowlist(stage.allowedCommands),
        // The stage's own value wins when it sets one; otherwise the project-wide default applies,
        // exactly as it did before this field existed (`stage.config.ts`).
        scopeViolationPolicy: stage.scopeViolation ?? stages.scopeViolation,
        port,
        host: worktreeHost(worktree),
        events: deps.events,
        logger: deps.logger,
    };

    const resultSchema = deps.resultSchemas.get(stage.verifier ?? stage.name);
    if (!resultSchema) {
        throw new Error(
            `stage "${stage.name}" names verifier "${stage.verifier ?? stage.name}", which has no registered result schema (have: ${[...deps.resultSchemas.keys()].join(', ')})`,
        );
    }

    const adapter = deps.agents.get(stage.adapter);
    if (!adapter) {
        throw new Error(
            `stage "${stage.name}" names adapter "${stage.adapter}", which is not registered (have: ${[...deps.agents.keys()].join(', ')})`,
        );
    }

    // Read again rather than passed down from `run`'s own check: nothing here has spent anything
    // since, and `run` reaches this through three separate call sites.
    const spent = stage.maxCardInputTokens === undefined ? 0 : await deps.events.totalInputTokens(deps.project, card.frontmatter.id);

    const budgeted = withinCardBudget(stage, spent);
    const run = await adapter.run({
        stage: interrupted?.spent ? withinInterruptedBudget(budgeted, interrupted.spent) : budgeted,
        context,
        planPath,
        learningsPath,
        title: card.frontmatter.title,
        resultSchema,
        baseSha: worktree.baseSha,
        ...(interrupted && { resume: interrupted.sessionId ? { sessionId: interrupted.sessionId } : {} }),
    });
    if (run.interrupted) {
        const { sessionId, wallClockMs, steps } = run.interrupted;
        const attempt: InterruptedAttempt = {
            baseSha: worktree.baseSha,
            ...(worktree.placement && { host: worktree.placement.hostName }),
            ...(sessionId && { sessionId }),
            spent: {
                wallClockMs: (interrupted?.spent?.wallClockMs ?? 0) + wallClockMs,
                steps: (interrupted?.spent?.steps ?? 0) + steps,
                inputTokens: (interrupted?.spent?.inputTokens ?? 0) + (budgetedInputTokens(run.usage) ?? 0),
            },
        };
        if (run.usageLimit) {
            throw new StageHeldError(card.frontmatter.id, stage.name, run.usage, attempt, run.usageLimit, run.heldUntil ?? run.usageLimit.resetsAt);
        }
        throw new StageInterruptedError(card.frontmatter.id, stage.name, run.usage, attempt);
    }

    const verifier = deps.verifiers.get(stage.verifier ?? stage.name);
    if (!verifier) {
        throw new Error(
            `stage "${stage.name}" names verifier "${stage.verifier ?? stage.name}", which is not registered (have: ${[...deps.verifiers.keys()].join(', ')})`,
        );
    }
    const reported = run.result;
    const verification = await verifier.verify({ worktree, scope, stage, cardId: card.frontmatter.id, card, result: reported });
    const verifiedTree = await deps.worktrees.uncommittedSnapshot(worktree);
    const failures = [...verification.failures];

    // A result that never parsed against the stage's own schema carries no judgment about the
    // code — there is nothing coherent for a verifier to have judged. Checked here, against the
    // same schema the report tool itself enforces, so every stage gets this for free instead of
    // each verifier re-parsing its own schema just to tell the dispatcher what it already knows
    // for its own reasons (`ReviewVerifier` does this today, to return early on a hallucinated
    // result before checking findings' provenance). Guarded on `safeParse` actually being a
    // function: every stage registered through `StagesModule` gets a real Zod schema here, but a
    // test double standing in for one is not this check's business to reject.
    const schemaInvalid = reported !== undefined && typeof resultSchema.safeParse === 'function' && !resultSchema.safeParse(reported).success;

    // A stage that never called the report tool never said it was finished. Whatever is in the
    // tree is where it happened to stop, not what it set out to produce. A stage that *did* call
    // it is a different sentence: the work is done and the runner lost the paperwork, not the
    // agent's fault, which is exactly what `run.resultDropped` distinguishes (`stage.agent.ts`).
    if (reported === undefined) {
        failures.unshift(
            run.resultDropped
                ? `the stage called ${REPORT_TOOL} and the result did not arrive, so the runner never saw it`
                : `the stage ended without calling ${REPORT_TOOL}, so it never reported finishing`,
        );
    }

    // A loop that ran out of steps did not finish; it stopped. Card 0002 exhausted its 60 steps
    // a third of the way through its plan, emitted a placeholder result, and passed — because
    // the diff was non-empty, in scope, and built. Truncation is knowable, so it is checked.
    //
    // Only when no more specific cause is known: a wall-clock or token-budget cutoff can land
    // with `truncated: true` well before the step count is exhausted, and naming the step cap
    // there would be false — `run.budgetFailure`, pushed below, already names the real cause.
    if (run.truncated && !run.budgetFailure && !run.engineFailure) {
        failures.unshift(`the stage used all ${stage.maxSteps} of its steps and was cut off mid-run — its work is partial whatever the diff shows`);
    }

    if (run.budgetFailure) {
        failures.unshift(run.budgetFailure);
    }

    // Ahead of everything else: when the engine stopped responding, nothing downstream of it —
    // an empty diff, a missing result, a build that never ran — describes a decision the stage
    // made. Leading with the cause stops the operator reading the symptoms as the problem.
    if (run.engineFailure) {
        failures.unshift(run.engineFailure);
    }

    // None of the checks above is a verdict on the code: a truncated run, a budget or engine
    // cutoff, a missing report and an unparseable result are all the stage failing to finish, not
    // a judgment of what it produced. Left `false` when a verifier's own substantive checks are
    // what failed — a bad citation, an empty diff, a verdict that contradicts its severities —
    // since those are exactly the judgments `writeTransition`/`kickback` should route past.
    //
    // `verification.reportRejected` (card 0250) joins the same list for the same reason: a review
    // or challenge rejected only for a fault in its own report — not a statement about the card's
    // code — has nothing for `onFail`'s next stage to act on either, so it retries this stage
    // instead of routing onward, the same as a truncated run or a dropped result do.
    const unjudged =
        failures.length > 0 &&
        (reported === undefined ||
            schemaInvalid ||
            run.truncated ||
            Boolean(run.budgetFailure) ||
            Boolean(run.engineFailure) ||
            Boolean(verification.reportRejected));

    // Only the verifier's own failures may stand: one added above means the run did not finish,
    // and a report from a run that did not finish is not a division to act on.
    const supportedRefusal = !unjudged && failures.length === verification.failures.length ? verification.supportedRefusal : undefined;

    return {
        passed: failures.length === 0,
        failures,
        changedPaths: verification.changedPaths,
        verifiedTree,
        scopeGrants: scope.grants(),
        result: reported,
        usage: run.usage,
        unjudged,
        resultDropped: run.resultDropped,
        engineStopReason: run.engineStopReason,
        trace: run.trace,
        ...(supportedRefusal && { supportedRefusal }),
    };
};
