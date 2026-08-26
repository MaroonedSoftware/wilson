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
 * already exists and that `card start` already trusts. `nextCard` orders every workable candidate,
 * lowest id first — respecting `unsatisfiedDependencies`, skipping flagged cards — and this runs each
 * one past `whyNotDispatchable` (the same refusal `card start` and `CardStageJob`'s dispatcher both go
 * through) and `CardJobs.inFlight` (the same claim check `card start` makes) before enqueuing.
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
     *
     * Walks `nextCard.candidates` in order rather than stopping at the first one, so one card in a
     * manual stage — `wilson card next`'s honest answer for a human — cannot silently wedge the queue
     * behind it forever. It skips a candidate only for that one reason. Any other refusal from
     * `whyNotDispatchable` (flagged, terminal, parking-lot, a stage the config doesn't know) means
     * something is actually wrong rather than merely manual, so the tick still stops there exactly as
     * it always has — `candidates` should never contain flagged/terminal/blocked cards in the first
     * place (`nextCard` already filters those), so reaching one of those refusals here is itself a
     * sign of drift between the two, not a case to route around.
     */
    private async tick(): Promise<void> {
        try {
            const cards = await this.board.list();
            const { candidates } = nextCard(cards);
            if (candidates.length === 0) return;

            const stages = await loadStages(this.boardConfig.boardRoot);

            // Bounds the walk so a board with nothing dispatchable — every remaining candidate sitting
            // in a manual stage — cannot turn into a scan of the whole backlog every `POLLER_INTERVAL_MS`,
            // forever. Well above any candidate list this project expects; raise it if that stops holding.
            const MAX_CANDIDATES_PER_TICK = 50;

            for (const candidate of candidates.slice(0, MAX_CANDIDATES_PER_TICK)) {
                const stageName = candidate.frontmatter.stage;
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

                const cardId = candidate.frontmatter.id;

                // The single most important check here: refuse a card something is already carrying,
                // exactly as `card start` does, so a poller tick can never put two jobs — and so two
                // agents — on one card's branch. Asked per candidate, not once, so a card someone else
                // already started does not stop the walk — it just isn't this tick's card to enqueue.
                const running = await this.cardJobs.inFlight(cardId);
                if (running) continue;

                const jobId = await this.broker.send('card.stage', { cardId, stageName });
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
}
