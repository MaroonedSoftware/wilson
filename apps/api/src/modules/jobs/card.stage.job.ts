import { Injectable } from 'injectkit';
import { Job, JobBroker } from '@maroonedsoftware/jobbroker';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { runAsProject } from '#modules/board/project.context.js';
import { EventLog } from '#modules/events/event.log.js';
import { Notifier } from '#modules/notify/notifier.js';
import { StageDispatcher } from '#modules/stages/stage.dispatcher.js';
import { loadStages } from '#modules/stages/stage.config.js';
import { decideChain } from './chain.decision.js';
import { CardJobs } from './card.jobs.js';
import { recordDeferral } from './dispatch.deferred.js';
import { classifyDispatchFailure, type SettledDispatch } from './dispatch.outcome.js';
import { flagRebaseConflict } from './flag.rebase.conflict.js';
import { poisonCard } from './poison.card.js';
import { PRE_DISPATCH_CHECKS } from './predispatch/index.js';
import { RunningCards } from './running.cards.js';

export interface CardStagePayload {
    cardId: string;
    stageName: string;
    /**
     * Card 0149. Which project's `runner.projects` row this job dispatches against.
     *
     * Optional so a `card.stage` row enqueued before this card shipped — `card.stage` job data was
     * `{ cardId, stageName }` then, and rows already in `pgboss.job` do not gain a field a migration
     * never touched — still runs: `CardStageJob.run` treats a payload with no `project` as the
     * daemon's own configured project (`BoardConfig.project` read outside any `runAsProject` scope —
     * see `project.context.ts`), the same project every job dispatched against before this card. A
     * daemon serving more than one project must always be given one explicitly; every job this card's
     * own code enqueues (`Poller`, and this class's own chain continuation below) always does.
     */
    project?: string;
}

/**
 * Runs one stage for one card, then decides whether the chain keeps going.
 *
 * `StageDispatcher.run` only ever reports where a card landed (`transitionedTo`), forward on a pass
 * or backward on a kickback, and leaves it unset for a `manual` stage it deliberately does not
 * touch. Turning "landed here" into "keep going" or "stop" is this job's decision, kept out of the
 * dispatcher so it stays queue-agnostic — `wilson card run` calls the same dispatcher without ever
 * enqueuing anything.
 */
@Injectable()
export class CardStageJob extends Job<CardStagePayload> {
    constructor(
        private readonly dispatcher: StageDispatcher,
        private readonly broker: JobBroker,
        private readonly board: BoardConfig,
        private readonly boardRepo: BoardRepository,
        private readonly events: EventLog,
        private readonly cardJobs: CardJobs,
        // Defaulted, not just typed optional: DI (jobs.module.ts) always supplies the shared
        // singleton, so this only matters for a test constructing a job by hand with the six
        // dependencies it cares about — it still gets a valid (if unshared) tracker rather than a
        // `this.running.add is not a function` crash on the first `run()` call.
        private readonly running: RunningCards = new RunningCards(),
    ) {
        super();
    }

    async run({ cardId, stageName, project }: CardStagePayload): Promise<void> {
        // Card 0149: see `CardStagePayload.project`'s own doc comment for what a missing `project`
        // means. Read here, before `runAsProject` below opens this job's own scope, so `this.board
        // .project` answers with the daemon's configured project (project.context.ts's fallback for
        // "nothing on the call stack has called runAsProject yet") rather than this job's own project,
        // which would be circular.
        const resolvedProject = project ?? this.board.project;
        this.running.add(resolvedProject, cardId);
        try {
            await runAsProject(resolvedProject, () => this.runStage(cardId, stageName));
        } finally {
            this.running.delete(resolvedProject, cardId);
        }
    }

    private async runStage(cardId: string, stageName: string): Promise<void> {
        for (const check of PRE_DISPATCH_CHECKS) {
            if (await check(this.deps(), cardId, stageName)) return;
        }

        let outcome;
        try {
            outcome = await this.dispatcher.run(cardId, stageName);
        } catch (error) {
            const failure = classifyDispatchFailure(error);
            // The only outcome that does not settle: rethrown so the queue retries under its policy.
            if (failure.kind === 'retry') throw error;

            await this.settle(cardId, stageName, failure);
            await this.cardJobs.clear(cardId);
            return;
        }

        // Unset means the stage just run was a `manual` gate the dispatcher left alone — nothing
        // for the chain to do until a human moves the card.
        if (!outcome.transitionedTo) {
            await this.cardJobs.clear(cardId);
            return;
        }

        const stages = await loadStages(this.board.boardRoot);
        const decision = decideChain(outcome.transitionedTo, stages, { needsHuman: outcome.needsHuman });

        if (decision.continue) {
            // Hand the claim straight to the next job rather than clearing and re-recording: the card
            // is continuously in flight across a chain, and a gap between the two is a window a
            // poller would enqueue into.
            //
            // Card 0102: `broker.send` can throw here on a connection pg-boss already closed —
            // `runner.stop()` gives up and returns once its own timeout elapses whether or not this
            // handler has finished, and this is the moment every multi-stage card passes through on
            // every transition. By the time it throws, the stage above has already passed and its
            // transition is already written, so this is not a failed stage and must not be treated
            // like one: letting the error propagate out of `run()` would make *this* job's own
            // pg-boss attempt look like it failed, and a retry would re-run `dispatcher.run` for a
            // stage that already passed and already committed its work — kicked back and retried,
            // which is strictly worse than the stranding it would be "fixing", and exactly what this
            // card's constraints forbid. So the throw is caught here instead: this attempt still
            // completes normally (no retry), `cardJobs.record` deliberately never runs (see
            // `chain.orphaned`'s comment in card.event.ts for why that is fine, not a second bug), and
            // what is genuinely lost — the handoff — is what gets recorded.
            // Card 0149: `project` is `this.board.project` — inside this job's own `runAsProject`
            // scope (see `run()`), so this is the project the stage that just passed actually ran
            // against, not whatever `resolvedProject` happened to default to. Carrying it forward
            // explicitly is what keeps a chain on a non-default project from silently landing back on
            // the daemon's configured one mid-chain.
            let jobId: string;
            try {
                jobId = await this.broker.send('card.stage', { cardId, stageName: outcome.transitionedTo, project: this.board.project });
            } catch (error) {
                await this.events.append({
                    project: this.board.project,
                    cardId,
                    stage: stageName,
                    type: 'chain.orphaned',
                    payload: {
                        target: outcome.transitionedTo,
                        reason: error instanceof Error ? error.message : String(error),
                    },
                });
                return;
            }
            await this.cardJobs.record(cardId, jobId);
            return;
        }

        await this.cardJobs.clear(cardId);

        // Recorded rather than silently dropped: an operator watching the card's history needs to
        // know the chain stopped here, and why, without having to reconstruct it from stage config.
        await this.events.append({
            project: this.board.project,
            cardId,
            stage: stageName,
            type: 'chain.stopped',
            payload: { target: outcome.transitionedTo, reason: decision.reason },
        });

        // A manual gate reached normally is one of the three moments PROJECT.md's Notification
        // section names (card 0050); the other two (needsHuman, poisoned) are notified where they
        // are written, in StageDispatcher and poisonCard. `needsHuman` is excluded here because it
        // is the other, already-notified reason the chain can stop on a perfectly ordinary agent
        // stage — decideChain checks it first, before it ever looks at the target's mode.
        if (!outcome.needsHuman) {
            const landedOn = stages.stages.find(s => s.name === outcome.transitionedTo);
            if (landedOn?.mode === 'manual') {
                await this.notifyManualGate(cardId, outcome.transitionedTo);
            }
        }
    }

    /**
     * Tell a person the card is waiting on them at a manual gate — one webhook call, off entirely
     * when `NOTIFY_WEBHOOK_URL` is unset (card 0050). The card is re-read for its title only when a
     * webhook is actually configured, so this costs nothing on the common, notification-off path.
     */
    private async notifyManualGate(cardId: string, stage: string): Promise<void> {
        if (!this.board.notifyWebhookUrl) return;

        const card = await this.boardRepo.read(cardId).catch(() => undefined);
        await new Notifier(this.board.notifyWebhookUrl, this.board.notifyBaseUrl).notify({
            project: this.board.project,
            cardId,
            title: card?.frontmatter.title ?? cardId,
            stage,
            moment: 'manual',
        });
    }

    /**
     * Flag a card for a human after its stage's prompt overflowed the model's context window (card
     * 0072) — not poisoned, because unlike an exhausted balance or a missing credential this is a
     * fact about how big this stage's turn got, not about the deployment, and it is recoverable by
     * doing the stage differently: a fresh session on the same branch, or a smaller card. Shaped
     * exactly like `flagRebaseConflict` for the same reason — `frontmatter.stage` is left exactly
     * where it was, `retries` is untouched, and `writeWithEvent` commits the flag and the transition
     * record together rather than as two writes a redelivered job could observe half-done.
     */
    private async flagContextOverflow(cardId: string, stageName: string, reason: string): Promise<void> {
        await this.events.append({
            project: this.board.project,
            cardId,
            stage: stageName,
            type: 'context.overflow',
            payload: { reason },
        });

        // Captured from the fresh row `writeWithEvent` reads inside its own transaction, the same
        // redelivery guard `flagRebaseConflict`/`poisonCard` use: a job that lands here again after
        // an earlier attempt already flagged this card has nothing new to report.
        let title = cardId;
        let alreadyFlagged = false;
        await this.boardRepo.writeWithEvent(
            cardId,
            `Flag ${cardId}: context overflow`,
            card => {
                title = card.frontmatter.title;
                alreadyFlagged = Boolean(card.frontmatter.needsHuman);
                return {
                    ...card,
                    frontmatter: { ...card.frontmatter, needsHuman: true, needsHumanReason: reason },
                };
            },
            {
                project: this.board.project,
                cardId,
                stage: stageName,
                type: 'transition.written',
                payload: { from: stageName, to: stageName, by: 'runner', needsHuman: true },
            },
        );

        if (this.board.notifyWebhookUrl && !alreadyFlagged) {
            await new Notifier(this.board.notifyWebhookUrl, this.board.notifyBaseUrl).notify({
                project: this.board.project,
                cardId,
                title,
                stage: stageName,
                moment: 'needs-human',
                reason,
            });
        }
    }

    /**
     * This job's dependencies as a plain object, for the collaborators that take them as an argument
     * rather than being injected with them — the pre-dispatch checks, and the three shared writes
     * `settle` routes to. Built per call rather than stored: a field holding a second reference to
     * the same four things would be one more thing to keep in step with the constructor.
     */
    private deps() {
        return { board: this.board, boardRepo: this.boardRepo, events: this.events, cardJobs: this.cardJobs };
    }

    /**
     * Carry out what `classifyDispatchFailure` decided.
     *
     * The `switch` is exhaustive by construction: every arm returns, and the `never` assignment in
     * `default` makes a new `DispatchOutcome` arm a compile error here rather than a card silently
     * falling through to no handling at all. That is the half of card 0101's warning a type can
     * enforce — the other half, a new `NotDispatchableReason` that no arm describes, still lands on
     * `poison` by design (see `classifyDispatchFailure`).
     */
    private async settle(cardId: string, stageName: string, outcome: SettledDispatch): Promise<void> {
        switch (outcome.kind) {
            case 'defer':
                return recordDeferral(this.deps(), { cardId, stageName, outstanding: outcome.outstanding, reason: outcome.reason });

            case 'defer-flagged':
                return recordDeferral(this.deps(), { cardId, stageName, reason: outcome.reason });

            case 'stale':
                await this.events.append({
                    project: this.board.project,
                    cardId,
                    stage: stageName,
                    type: 'stage.stale',
                    payload: { wantedStage: stageName, actualStage: outcome.actualStage },
                });
                return;

            case 'flag-rebase':
                return flagRebaseConflict(this.deps(), { project: this.board.project, cardId, stageName, error: outcome.error });

            case 'flag-context-overflow':
                return this.flagContextOverflow(cardId, stageName, outcome.reason);

            case 'poison': {
                const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
                // The job returns normally afterwards so the queue does not retry it either — the
                // whole point is that the next attempt fails identically.
                return poisonCard(this.deps(), { project: this.board.project, cardId, stageName, reason });
            }

            default: {
                const unhandled: never = outcome;
                throw new Error(`unhandled dispatch outcome: ${JSON.stringify(unhandled)}`);
            }
        }
    }
}
