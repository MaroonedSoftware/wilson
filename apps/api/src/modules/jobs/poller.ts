import { setTimeout as delay } from 'node:timers/promises';
import { Injectable } from 'injectkit';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { nextCard } from '#modules/board/next.card.js';
import { runAsProject } from '#modules/board/project.context.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { EventLog } from '#modules/events/event.log.js';
import { findStage, type ProjectStages } from '#modules/stages/stage.config.js';
import { StageConfigStore } from '#modules/stages/stage.config.store.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { POLLER_INTERVAL_MS } from '#modules/settings/poller.interval.setting.js';
import { whyNotDispatchable } from './dispatchable.js';
import { CardJobs } from './card.jobs.js';

/**
 * Enqueue the one next dispatchable card, on an interval, so `card.stage` jobs start themselves
 * instead of waiting for `wilson card start`.
 *
 * Deliberately not a second idea of "ready": every question this asks is answered by something that
 * already exists and that `card start` already trusts. `nextCard` orders every workable candidate,
 * lowest id first — respecting `unsatisfiedDependencies`, skipping flagged cards — and this runs each
 * one past `whyNotDispatchable` (the same refusal `card start` and `CardStageJob`'s dispatcher both go
 * through), `CardJobs.inFlight` (the same claim check `card start` makes), and — card 0128 —
 * `BoardRepository.scopeConflict` (the same check `deferOnScopeConflict`, jobs/predispatch/scope.conflict.ts,
 * runs right before dispatch) before enqueuing. The last one is deliberately asked here rather than
 * folded into `whyNotDispatchable`: it is a question about every other card on the board, not about
 * whether this one card's own stage is dispatchable, and `whyNotDispatchable`'s doc already says it
 * stays out of that for the CLI path — this keeps it staying out, for both callers.
 * If this ever disagrees with `wilson card start` about whether a card is ready, one of them has a
 * bug — this must never grow a second definition of "ready" to resolve that disagreement.
 *
 * `nextCard.next` — the single lowest-id candidate — is what `wilson card next` shows a human, and a
 * card sitting in a manual stage genuinely is the next thing for a *person* to do. It is not
 * something the queue will ever dispatch, though, so this walks `nextCard.candidates` instead of
 * trusting `next`: it skips past a manual (or `command`) stage to the next candidate rather than
 * refusing the whole tick over it. That is the one and only reason this and `wilson card next` may
 * name different cards — do not "fix" that by changing what `next` means; card 0117's whole point was
 * to leave it alone.
 *
 * Card 0127: `backlog` is the one exception to "skip past a manual stage" — it is a queue the poller
 * itself works, not merely a person's. A card there was already approved and pinned on arrival
 * (`BoardWriteService.move`), so there is nothing left for a human to decide; this advances it to
 * `backlog`'s own `onPass` and enqueues it there, exactly as if a human had moved and started it by
 * hand. `backlog` is named explicitly for this, never derived from `mode: manual` — `ready` is manual
 * too, with `onPass: merged`, and `planning` is manual with `onPass: backlog`; either one advanced the
 * same way would merge or approve a card with nobody having looked.
 *
 * One candidate per project per tick, never more: a board with thirty ready cards must not become
 * thirty concurrent stages the moment this starts ticking. `CARD_STAGE_CONCURRENCY` is what actually
 * bounds how many run at once, process-wide across every project (see its own doc comment in
 * `jobs.module.ts` for why that stays a global rather than a per-project budget); this only ever
 * offers one more, per project.
 *
 * Enqueues exactly as `wilson card start` does — `broker.send` then `cardJobs.record`, in that order,
 * so the claim never precedes the job existing.
 *
 * Started and stopped by whatever holds the `JobRunner` (see `jobs.module.ts`); `start` and `stop`
 * are synchronous/awaitable respectively so a caller that already does `runner.start()` /
 * `await runner.stop()` can drive this alongside it without knowing it exists. `stop` waits out
 * whatever tick is in flight rather than abandoning it mid-enqueue, so a caller relying on "the
 * poller is stopped" once `stop()` resolves — the shutdown report in `jobs.module.ts` among them —
 * gets a poller that is actually quiet, not one that might still land an enqueue a moment later.
 *
 * Card 0149: one tick now walks every registered project in turn, not just the one this process's own
 * environment named — `tick` lists them (`ProjectRepository.list`, re-read every tick so a project
 * added by hand while the daemon runs is picked up without a restart) and hands each one to
 * `tickProject`, wrapped in `runAsProject` so `this.board`/`this.boardConfig` answer for that project
 * for the duration — see `project.context.ts` for why an ambient context is what makes that true
 * without this class's own fields changing per project. At most one candidate is still enqueued *per
 * project* per tick — the reasoning `tickProject`'s own doc comment gives for one candidate at all
 * applies per board, not globally, so one project's queue depth never throttles another's. `projects`
 * is optional, defaulting to `undefined`, purely so a test can construct a `Poller` against a single
 * fixed `BoardConfig` without a real repository — `undefined` falls back to the one project
 * `boardConfig.project` already names, reproducing single-project behaviour exactly (this card's "one
 * project must behave exactly as it does today" acceptance criterion). Production DI (`jobs.module.ts`)
 * always supplies the real one.
 */
// Card 0149: explicit `deps` rather than relying on emitted decorator metadata — `projects` below is
// typed `ProjectRepository | undefined` (a union, for the test-construction fallback its own doc
// comment explains), and TypeScript's `emitDecoratorMetadata` cannot represent a union in
// `design:paramtypes`; it would degrade to `Object`, which injectkit cannot resolve against a
// registered class token. Explicit `deps` (injectkit's "Option A") sidesteps that entirely.
@Injectable({ deps: [BoardRepository, BoardConfig, StageConfigStore, JobBroker, CardJobs, Logger, SettingsStore, EventLog, ProjectRepository] })
export class Poller {
    private abort: AbortController | undefined;
    private loopPromise: Promise<void> | undefined;

    constructor(
        private readonly board: BoardRepository,
        private readonly boardConfig: BoardConfig,
        private readonly stageConfigs: StageConfigStore,
        private readonly broker: JobBroker,
        private readonly cardJobs: CardJobs,
        private readonly logger: Logger,
        private readonly settings: SettingsStore,
        private readonly events: EventLog,
        private readonly projects: ProjectRepository | undefined = undefined,
    ) {}

    /** Idempotent: calling `start` while already running does nothing. */
    start(): void {
        if (this.abort) return;
        this.abort = new AbortController();
        this.loopPromise = this.loop(this.abort.signal);
    }

    /**
     * Stop ticking and wait for whatever tick is currently in flight to finish.
     *
     * Safe to call when not running. Waiting out the in-flight tick — rather than merely cancelling
     * the timer — is what makes "stopped" mean "will not enqueue anything else", which is the
     * property `jobs.module.ts` needs before it computes what shutdown left abandoned.
     */
    async stop(): Promise<void> {
        this.abort?.abort();
        await this.loopPromise;
        this.abort = undefined;
        this.loopPromise = undefined;
    }

    private async loop(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            // Read fresh on every iteration, not once at `start()` — card 0115's whole point.
            // A row written mid-run changes the wait about to start, not just the next process.
            const intervalMs = await this.settings.get(POLLER_INTERVAL_MS);
            try {
                await delay(intervalMs, undefined, { signal });
            } catch {
                // Aborted while waiting for the next tick — nothing ran, nothing to clean up.
                return;
            }
            await this.tick();
        }
    }

    /**
     * Card 0149. Every registered project, considered in turn — the whole of task 3.
     *
     * Lists projects fresh every tick (`ProjectRepository.list`), the same "read fresh, not once at
     * `start()`" reasoning `loop`'s interval read already follows, so a project registered by hand
     * after this daemon booted is picked up without a restart. Each row is re-registered on
     * `boardConfig` before its project runs — cheap (an in-memory map write) and idempotent — which is
     * also how a path an operator edited by hand in `runner.projects` reaches a running daemon.
     *
     * `tickProject` runs inside `runAsProject`, so every read `this.board`/`this.boardConfig` make
     * during that call answers for this one project — see `project.context.ts`. A project whose own
     * tick throws is logged and skipped, exactly as a single-project tick always was; it does not stop
     * the walk over the *other* registered projects, which is the multi-project reading of "one tick
     * fails, log it, try again next interval" now that "next interval" is not the only remaining
     * chance for a different project this same tick.
     */
    private async tick(): Promise<void> {
        let names: string[];
        try {
            if (this.projects) {
                const rows = await this.projects.list();
                for (const row of rows) this.boardConfig.register(row);
                names = rows.map(row => row.name);
            } else {
                // No real repository (a test constructing a `Poller` against one fixed `StaticBoardConfig`
                // — see this class's own doc comment): fall back to the one project that config already
                // names, reproducing single-project behaviour exactly.
                names = [this.boardConfig.project];
            }
        } catch (error) {
            this.logger.error(error);
            return;
        }

        for (const name of names) {
            try {
                await runAsProject(name, () => this.tickProject());
            } catch (error) {
                // A tick that fails is not fatal to the loop: log and try again next interval rather
                // than letting one bad read or a dropped connection stop the poller for good, and —
                // card 0149 — without stopping the walk over any other registered project either.
                this.logger.error(error);
            }
        }
    }

    /**
     * One project's tick: at most one enqueue, and nothing written or logged at `info` when there is
     * nothing to do. This runs forever, so an idle tick must be cheap and silent — a line per tick is
     * a log nobody reads.
     *
     * Walks `nextCard.candidates` in order rather than stopping at the first one, so one card in a
     * manual stage — `wilson card next`'s honest answer for a human — cannot silently wedge the queue
     * behind it forever. It skips a candidate only for that one reason, plus one more added by card
     * 0128: a candidate `BoardRepository.scopeConflict` says would defer. Both are cards the walk must
     * pass over rather than stop at, for the same underlying reason — stopping there starves every
     * candidate behind it, and a card that would defer is no more this tick's card to enqueue than one
     * sitting in a manual stage is. Any other refusal from `whyNotDispatchable` (flagged, terminal,
     * parking-lot, a stage the config doesn't know) means something is actually wrong rather than
     * merely manual, so the tick still stops there exactly as it always has — `candidates` should never
     * contain flagged/terminal/blocked cards in the first place (`nextCard` already filters those), so
     * reaching one of those refusals here is itself a sign of drift between the two, not a case to
     * route around.
     */
    private async tickProject(): Promise<void> {
        try {
            const cards = await this.board.list();
            const { candidates } = nextCard(cards);
            if (candidates.length === 0) return;

            const stages = await this.stageConfigs.load();

            // Bounds the walk so a board with nothing dispatchable — every remaining candidate sitting
            // in a manual stage — cannot turn into a scan of the whole backlog every `POLLER_INTERVAL_MS`,
            // forever. Well above any candidate list this project expects; raise it if that stops holding.
            const MAX_CANDIDATES_PER_TICK = 50;

            for (const candidate of candidates.slice(0, MAX_CANDIDATES_PER_TICK)) {
                const stageName = candidate.frontmatter.stage;
                const cardId = candidate.frontmatter.id;

                // Card 0127: `backlog`, named explicitly — never derived from `mode: manual`, so
                // `ready` and every other manual stage fall through to the ordinary refusal below
                // exactly as before. A card here is already approved and pinned; advance it rather
                // than skipping it as "merely manual".
                if (stageName === 'backlog') {
                    const advanced = await this.advanceBacklogCard(cardId, stages);
                    if (!advanced) continue;
                    return;
                }

                const reason = whyNotDispatchable(candidate, stages);
                if (reason) {
                    const stage = stages.stages.find(s => s.name === stageName);
                    // A stage the queue never dispatches (`manual` or `command`) — try the next
                    // candidate instead of refusing the whole tick over it.
                    if (stage && stage.mode !== 'agent') continue;
                    // Any other refusal means something is wrong, not merely manual — stop here,
                    // exactly as a single-candidate tick always has.
                    return;
                }

                // The single most important check here: refuse a card something is already carrying,
                // exactly as `card start` does, so a poller tick can never put two jobs — and so two
                // agents — on one card's branch. Asked per candidate, not once, so a card someone else
                // already started does not stop the walk — it just isn't this tick's card to enqueue.
                const running = await this.cardJobs.inFlight(cardId);
                if (running) continue;

                // Card 0128: ask the same scope-conflict question `deferOnScopeConflict`
                // (jobs/predispatch/scope.conflict.ts) asks right before `dispatcher.run`, but before
                // ever enqueueing rather than after. Skipping a conflicted candidate here is cheap;
                // letting it through only to have the job defer immediately is not merely wasteful —
                // that defer clears the card's claim and returns control to this same walk, offering
                // the identical candidate right back to it. Card 0117 taught the poller to walk past a
                // manual stage rather than let it wedge the queue; a card that would defer is the same
                // problem, so it gets the same answer: try the next candidate instead.
                //
                // Deliberately asked here and not folded into `whyNotDispatchable` (dispatchable.ts):
                // that function is the one refusal `wilson card start` and the poller are required to
                // agree on, and a scope conflict is a question about every *other* card on the board,
                // not about this one — `whyNotDispatchable` already documents that it stays out of
                // this for the CLI path, and doing it any differently for the poller would just be a
                // second definition of the same check.
                //
                // Best-effort like every other lookup a tick makes: a check that cannot answer is
                // treated as "no conflict" rather than stopping the walk over it. A real conflict a
                // failed lookup missed here is still caught correctly by `deferOnScopeConflict` once
                // the job actually runs — this is an optimization to avoid the wasted enqueue, not the
                // check of record.
                let conflict: { cardId: string } | undefined;
                try {
                    conflict = await this.board.scopeConflict(this.events, this.boardConfig.project, candidate, stages);
                } catch {
                    conflict = undefined;
                }
                if (conflict) continue;

                // Card 0149: `project` names which project's row `CardStageJob` dispatches against —
                // required, not read back off `this.boardConfig.project` inside the job, because the
                // job may run in this process well after this tick's `runAsProject` scope has exited,
                // or in another process entirely.
                const jobId = await this.broker.send('card.stage', { cardId, stageName, project: this.boardConfig.project });
                await this.cardJobs.record(cardId, jobId);
                this.logger.info(`poller: enqueued ${cardId} · ${stageName} (job ${jobId})`);
                return;
            }
        } catch (error) {
            // A tick that fails is not fatal to the loop: log and try again next interval rather
            // than letting one bad read or a dropped connection stop the poller for good.
            this.logger.error(error);
        }
    }

    /**
     * Advance one `backlog` card to `backlog`'s own `onPass` target — read from config, never
     * hard-coded — and enqueue it there. Returns whether it did: `false` means "something already
     * holds this card's claim, try the next candidate", the same meaning the ordinary enqueue path
     * below gives its own in-flight check, not "something is wrong".
     *
     * Writes the transition itself, `by: 'runner'` — the value `StageDispatcher.writeTransition`
     * already uses for every transition the system makes on its own, as opposed to `'human'` for one
     * `wilson card move`/`approve` records over HTTP. Does not touch `planVersionId`: a card only
     * ever reaches `backlog` already pinned (`BoardWriteService.move`, card 0127), so re-pinning here
     * would just restate the version that pinning already recorded.
     */
    private async advanceBacklogCard(cardId: string, stages: ProjectStages): Promise<boolean> {
        const running = await this.cardJobs.inFlight(cardId);
        if (running) return false;

        const target = findStage(stages, 'backlog').onPass;

        await this.board.writeWithEvent(
            cardId,
            `Move ${cardId} to ${target}`,
            card => ({ ...card, frontmatter: { ...card.frontmatter, stage: target } }),
            {
                project: this.boardConfig.project,
                cardId,
                stage: target,
                type: 'transition.written',
                payload: { from: 'backlog', to: target, by: 'runner' },
            },
        );

        const jobId = await this.broker.send('card.stage', { cardId, stageName: target, project: this.boardConfig.project });
        await this.cardJobs.record(cardId, jobId);
        this.logger.info(`poller: advanced ${cardId} · backlog → ${target}, enqueued (job ${jobId})`);
        return true;
    }
}
