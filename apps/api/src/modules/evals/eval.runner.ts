import { readFile } from 'node:fs/promises';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { StageAgentMap } from '#modules/agent/stage.agent.js';
import { StageHeldError, StageInterruptedError } from '#modules/agent/stage.interrupt.js';
import { ScopeKickbackError } from '#modules/agent/tools/index.js';
import { BoardConfig } from '#modules/board/board.config.js';
import type { Card } from '#modules/board/card.js';
import { EventLog } from '#modules/events/event.log.js';
import { HostPlacer, NoHostAvailable } from '#modules/host/host.placer.js';
import type { RemotePlacement } from '#modules/host/placement.js';
import { DRAIN_ENABLED } from '#modules/settings/drain.enabled.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { scalesWithDiff, withDepth } from '#modules/stages/lane.depth.js';
import { findStage, validateStages, type ProjectStages, type StageConfig } from '#modules/stages/stage.config.js';
import { checkFinishedTree, executeStage } from '#modules/stages/stage.execution.js';
import { prepareStage } from '#modules/stages/stage.preparation.js';
import { StageResultSchemaMap, type StageOutcome } from '#modules/stages/stage.result.js';
import { StageVerifierMap } from '#modules/stages/stage.verifier.js';
import { WorktreeManager } from '#modules/worktree/worktree.manager.js';
import { EvalFixtureRepository, type EvalFixtureRow } from './eval.fixture.repository.js';
import { evalRunId } from './eval.run.id.js';
import { EvalRunRepository, type EvalBatchRow, type EvalRunEnding, type EvalRunRow } from './eval.run.repository.js';

/** The most of a run's patch kept, the same per-file cap the diff view uses. */
const MAX_PATCH_BYTES = 256 * 1024;

/** A tool event per call means a long run has thousands; enough to count any stage's. */
const MAX_COUNTED_EVENTS = 100_000;

/** What the job should do once a step of a batch is over. */
export type EvalStep = { kind: 'next' } | { kind: 'wait' } | { kind: 'done' };

/** A lane document frozen on a batch, as the stages it describes. */
const stagesFrom = (lanes: unknown, batchId: string): ProjectStages => validateStages(lanes, `eval batch ${batchId}`);

const planFor = (fixture: EvalFixtureRow, id: string): Card => ({ ...fixture.plan, frontmatter: { ...fixture.plan.frontmatter, id } });

/**
 * Runs a batch one run at a time, with the same preparation, agent and verifiers a card's stage gets.
 *
 * What it never does is what makes a replay safe: read a card row, write a transition, commit, or
 * merge. A run's work lives only in its throwaway worktree, kept afterwards as a patch on the run's
 * row, and a run's id has no card behind it (`eval.run.id.ts`).
 */
@Injectable()
export class EvalRunner {
    constructor(
        private readonly config: BoardConfig,
        private readonly runs: EvalRunRepository,
        private readonly fixtures: EvalFixtureRepository,
        private readonly worktrees: WorktreeManager,
        private readonly agents: StageAgentMap,
        private readonly verifiers: StageVerifierMap,
        private readonly resultSchemas: StageResultSchemaMap,
        private readonly events: EventLog,
        private readonly placer: HostPlacer,
        private readonly settings: SettingsStore,
        private readonly logger: Logger,
    ) {}

    /** Run the batch's next run, if it has one and it is allowed to start now. */
    async step(batchId: string): Promise<EvalStep> {
        const batch = await this.runs.batch(batchId);
        if (!batch || batch.status !== 'running') return { kind: 'done' };

        if (await this.settings.get(DRAIN_ENABLED).catch(() => false)) {
            await this.runs.setWaiting(batchId, 'the server is draining');
            return { kind: 'wait' };
        }

        const spent = await this.runs.outputTokensSpent(batchId);
        if (spent >= batch.maxOutputTokens) {
            await this.runs.stopBatch(batchId, `spent ${spent} output tokens, reaching its limit of ${batch.maxOutputTokens}`);
            return { kind: 'done' };
        }

        const run = await this.runs.claimNext(batchId);
        if (!run) {
            if (!(await this.runs.hasRunning(batchId))) await this.runs.finishBatch(batchId);
            return { kind: 'done' };
        }

        const fixture = await this.fixtures.find(run.fixtureId);
        if (!fixture) {
            await this.runs.finishRun(run.id, { status: 'errored', error: `fixture ${run.fixtureId} is gone` });
            return { kind: 'next' };
        }

        let stage: StageConfig;
        let stages: ProjectStages;
        try {
            stages = stagesFrom(run.arm === 'candidate' ? batch.candidateLanes : batch.currentLanes, batch.id);
            stage = await this.stageFor(stages, fixture);
        } catch (err) {
            await this.runs.finishRun(run.id, { status: 'errored', error: (err as Error).message });
            return { kind: 'next' };
        }

        const id = evalRunId(run.id);
        const placed = await this.placer.place(this.config.project, id, stage, batch.host, true);
        if (placed instanceof NoHostAvailable || !placed) {
            await this.runs.releaseRun(run.id);
            await this.runs.setWaiting(batchId, placed ? placed.message : `${batch.host} cannot take it`);
            return { kind: 'wait' };
        }
        await this.runs.setWaiting(batchId, undefined);

        const { ending, heldBy } = await this.execute(batch, run, fixture, stages, stage, placed);
        await this.runs.finishRun(run.id, ending);
        // An account at its limit is spending real cards' quota too, so a batch gives way rather than wait.
        if (heldBy) {
            await this.runs.stopBatch(batchId, heldBy);
            return { kind: 'done' };
        }
        return { kind: 'next' };
    }

    /**
     * The arm's stage, as deep as a card's stage would run on this diff, and always on a host: a
     * batch's whole point is that every run lands on the same machine.
     */
    private async stageFor(stages: ProjectStages, fixture: EvalFixtureRow): Promise<StageConfig> {
        const lane = findStage(stages, fixture.stage);
        const diffstat = scalesWithDiff(lane)
            ? await this.worktrees.numstatSince(fixture.baseSha, fixture.headSha).catch((err: Error) => {
                  this.logger.warn(`could not measure fixture ${fixture.id}'s diff, so it runs as written: ${err.message}`);
                  return undefined;
              })
            : undefined;
        return { ...(diffstat ? withDepth(lane, diffstat) : lane), placement: 'remote' };
    }

    private async execute(
        batch: EvalBatchRow,
        run: EvalRunRow,
        fixture: EvalFixtureRow,
        stages: ProjectStages,
        stage: StageConfig,
        placement: RemotePlacement,
    ): Promise<{ ending: EvalRunEnding; heldBy?: string }> {
        const id = evalRunId(run.id);
        const branch = `eval/${id}`;
        const started = Date.now();
        let ending: EvalRunEnding;
        let heldBy: string | undefined;
        try {
            const cut = await this.worktrees.create(id, branch, fixture.headSha, placement);
            // The tree is at the attempt's head, and its diff is everything since the attempt's fork
            // point, so a later stage sees the whole card rather than an empty diff.
            const worktree = { ...cut, baseSha: fixture.baseSha };
            const card = planFor(fixture, id);
            const { planPath, learningsPath, scope } = await prepareStage(
                {
                    config: this.config,
                    worktrees: this.worktrees,
                    events: this.events,
                    logger: this.logger,
                    learnings: { load: async () => batch.learnings },
                },
                { cardId: id, stageName: stage.name, stages, stage, card, pinnedSha: fixture.planVersionId, worktree, placement, boardCards: [] },
            );
            const ran = await executeStage(
                {
                    project: this.config.project,
                    worktrees: this.worktrees,
                    agents: this.agents,
                    verifiers: this.verifiers,
                    resultSchemas: this.resultSchemas,
                    events: this.events,
                    logger: this.logger,
                },
                { card, stage, worktree, scope, planPath, learningsPath, stages },
            );
            const outcome = ran.passed ? await checkFinishedTree(this.worktrees, ran, worktree, scope, stage) : ran;
            ending = this.judged(outcome, started);
        } catch (err) {
            ending = await this.stopped(err as Error, id, placement, started);
            if (err instanceof StageHeldError) heldBy = err.message;
        }

        const trail = await this.events.tail(this.config.project, id, MAX_COUNTED_EVENTS).catch(() => []);
        ending.toolCalls = trail.filter(event => event.type === 'tool.executed').length;
        ending.scopeDenials = trail.filter(event => event.type === 'tool.denied').length;

        await this.worktrees.reclaim(id, placement).catch(err => this.warn(id, 'reclaim its worktree', err));
        await this.worktrees.reclaim(`${id}-baseline`, placement).catch(err => this.warn(id, 'reclaim its baseline', err));
        Object.assign(ending, await this.keptPatch(id));
        await this.worktrees.forget(id, [branch, `card/${id}-baseline`], placement).catch(err => this.warn(id, 'clean up after itself', err));
        await this.placer.releaseSlot(placement.slotKey, this.config.project, id).catch(err => this.warn(id, `release ${placement.slotKey}`, err));
        return { ending, ...(heldBy && { heldBy }) };
    }

    private judged(outcome: StageOutcome, started: number): EvalRunEnding {
        return {
            status: outcome.passed ? 'passed' : 'failed',
            // Nobody is there to answer, so a stage that stops to ask did not finish.
            failures: outcome.blocked ? [`stopped to ask: ${outcome.blocked.question}`] : outcome.failures,
            unjudged: Boolean(outcome.unjudged),
            reportRejected: Boolean(outcome.reportRejected),
            truncated: Boolean(outcome.truncated),
            ...(outcome.result !== undefined && { result: outcome.result }),
            wallClockMs: Date.now() - started,
            ...usageColumns(outcome.usage),
        };
    }

    /** How a run that threw ended. Only a scope violation says anything about the work. */
    private async stopped(err: Error, id: string, placement: RemotePlacement, started: number): Promise<EvalRunEnding> {
        const wallClockMs = Date.now() - started;
        if (err instanceof ScopeKickbackError) return { status: 'failed', failures: [err.message], wallClockMs };
        if (err instanceof StageInterruptedError) {
            return { status: 'interrupted', error: err.message, wallClockMs, ...usageColumns(err.usage) };
        }
        if (!(await this.placer.isAlive(placement))) {
            await this.placer.markLost(placement, `${id}: ${err.message}`);
            return { status: 'interrupted', error: `${placement.hostName} stopped answering: ${err.message}`, wallClockMs };
        }
        return { status: 'errored', error: err.message, wallClockMs };
    }

    /** What the run left in its tree, as `reclaim` saved it. A run commits nothing, so this is its work. */
    private async keptPatch(id: string): Promise<Pick<EvalRunEnding, 'patch' | 'patchTruncated'>> {
        const text = await readFile(this.worktrees.failedAttemptPatchPath(id), 'utf8').catch(() => undefined);
        if (text === undefined) return {};
        const bytes = Buffer.byteLength(text);
        return bytes > MAX_PATCH_BYTES
            ? { patch: Buffer.from(text).subarray(0, MAX_PATCH_BYTES).toString('utf8'), patchTruncated: true }
            : { patch: text };
    }

    private warn(id: string, doing: string, err: Error): void {
        this.logger.warn(`eval run ${id} could not ${doing}: ${err.message}`);
    }
}

const usageColumns = (usage: StageOutcome['usage']): Pick<EvalRunEnding, 'inputTokens' | 'cachedInputTokens' | 'outputTokens'> => ({
    ...(usage?.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
    ...(usage?.cachedInputTokens !== undefined && { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage?.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
});
