import { setTimeout as delay } from 'node:timers/promises';
import { Injectable } from 'injectkit';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { nextCard } from '#modules/board/next.card.js';
import { loadStages } from '#modules/stages/stage.config.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { POLLER_INTERVAL_MS } from '#modules/settings/poller.interval.setting.js';
import { whyNotDispatchable } from './dispatchable.js';
import { CardJobs } from './card.jobs.js';

/**
 * Enqueue the one next dispatchable card, on an interval, so `card.stage` jobs start themselves
 * instead of waiting for `wilson card start`.
 *
 * Deliberately not a second idea of "ready": every question this asks is answered by something that
 * already exists and that `card start` already trusts. `nextCard` picks the single lowest-id
 * candidate — respecting `unsatisfiedDependencies`, skipping flagged cards — and this still runs that
 * candidate past `whyNotDispatchable` (the same refusal `card start` and `CardStageJob`'s dispatcher
 * both go through) and `CardJobs.inFlight` (the same claim check `card start` makes) before enqueuing.
 * If this ever disagrees with `wilson card start` about whether a card is ready, one of them has a
 * bug — this must never grow a second definition of "ready" to resolve that disagreement.
 *
 * One candidate per tick, never more: a board with thirty ready cards must not become thirty
 * concurrent stages the moment this starts ticking. `CARD_STAGE_CONCURRENCY` is what actually bounds
 * how many run at once; this only ever offers one more.
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
 */
@Injectable()
export class Poller {
    private abort: AbortController | undefined;
    private loopPromise: Promise<void> | undefined;

    constructor(
        private readonly board: BoardRepository,
        private readonly boardConfig: BoardConfig,
        private readonly broker: JobBroker,
        private readonly cardJobs: CardJobs,
        private readonly logger: Logger,
        private readonly settings: SettingsStore,
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
     * One tick: at most one enqueue, and nothing written or logged at `info` when there is nothing
     * to do. This runs forever, so an idle tick must be cheap and silent — a line per tick is a log
     * nobody reads.
     */
    private async tick(): Promise<void> {
        try {
            const cards = await this.board.list();
            const { next } = nextCard(cards);
            if (!next) return;

            const stages = await loadStages(this.boardConfig.boardRoot);
            if (whyNotDispatchable(next, stages)) return;

            const cardId = next.frontmatter.id;
            const stageName = next.frontmatter.stage;

            // The single most important check here: refuse a card something is already carrying,
            // exactly as `card start` does, so a poller tick can never put two jobs — and so two
            // agents — on one card's branch.
            const running = await this.cardJobs.inFlight(cardId);
            if (running) return;

            const jobId = await this.broker.send('card.stage', { cardId, stageName });
            await this.cardJobs.record(cardId, jobId);
            this.logger.info(`poller: enqueued ${cardId} · ${stageName} (job ${jobId})`);
        } catch (error) {
            // A tick that fails is not fatal to the loop: log and try again next interval rather
            // than letting one bad read or a dropped connection stop the poller for good.
            this.logger.error(error);
        }
    }
}
