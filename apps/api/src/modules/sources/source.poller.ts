import { setTimeout as delay } from 'node:timers/promises';
import { Injectable } from 'injectkit';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { runAsProject } from '#modules/board/project.context.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { SOURCE_POLL_ENABLED } from '#modules/settings/source.poll.enabled.setting.js';
import { SOURCE_POLL_INTERVAL_MS, SOURCE_POLL_INTERVAL_MS_DEFAULT } from '#modules/settings/source.poll.interval.setting.js';
import { CardSourceRegistry } from './card.source.registry.js';
import { InboundCardWriter } from './inbound.card.writer.js';
import { SourceCursorRepository } from './source.cursor.repository.js';

/**
 * The first transport for card sources (PROJECT.md's "Card sources"): on an interval, ask every
 * registered `CardSource` what changed since its stored cursor, hand each reported item to
 * `InboundCardWriter.apply`, and advance that source's cursor once the fetch — and every item in it —
 * has been applied.
 *
 * Mirrors `Poller` (`#modules/jobs/poller.js`) deliberately, per this card's Constraints: a plain
 * interval loop, not a jobbroker schedule, with the interval re-read from `SOURCE_POLL_INTERVAL_MS`
 * fresh on every iteration (not once at `start()`), an `AbortController`, and a `loopPromise` that
 * `stop()` awaits so "stopped" means "will not write anything else". A second loop beside `Poller`,
 * never a branch inside it — `Poller` enqueues board work already on the board, this imports tickets
 * that are not, and folding them together would give one class two reasons to tick and one interval
 * governing both.
 *
 * Per project, through `runAsProject` — the same shape `Poller.tick` uses — walking
 * `ProjectRepository.list` fresh every tick so a project registered while the daemon runs is picked up
 * without a restart. Unlike `Poller`, whose on/off switch (`POLLER_ENABLED`) gates the whole loop's
 * `start`/`stop` (`PollerSettingService`), `SOURCE_POLL_ENABLED` is asked inside `tickProject` itself,
 * once per project per tick: pausing one project's imports must never stop another registered
 * project's, and gating `start`/`stop` on a single project-scoped setting cannot express that.
 *
 * `InboundCardWriter.apply` is the only board write this makes, and has no stage parameter — this
 * poller cannot promote a card out of `parking-lot` by construction, not by a check here re-deriving
 * that guarantee.
 *
 * A refusal (`{ ok: false }`) or a throw from one source is logged and skipped: it must not advance
 * that source's cursor, must not stop the other sources in the same tick, and must not stop the loop.
 * `CardSourceRegistry` is constructed with an empty list until [[0199]] registers a real source, so
 * every tick today walks zero sources — this is the intended end state for this card, the same way
 * [[0196]] shipped a registry with no sources and [[0203]] a writer with no caller.
 */
@Injectable({ deps: [CardSourceRegistry, SourceCursorRepository, InboundCardWriter, BoardConfig, SettingsStore, Logger, ProjectRepository] })
export class SourcePoller {
    private abort: AbortController | undefined;
    private loopPromise: Promise<void> | undefined;
    // Last interval `loop` successfully read from `settings`, so a failing read has something better
    // than `SOURCE_POLL_INTERVAL_MS_DEFAULT` to fall back to. See `loop`'s own doc comment (card 0271).
    private lastIntervalMs: number | undefined;

    constructor(
        private readonly registry: CardSourceRegistry,
        private readonly cursors: SourceCursorRepository,
        private readonly writer: InboundCardWriter,
        private readonly boardConfig: BoardConfig,
        private readonly settings: SettingsStore,
        private readonly logger: Logger,
        private readonly projects: ProjectRepository | undefined = undefined,
    ) {}

    /** Idempotent: calling `start` while already running does nothing. */
    start(): void {
        if (this.abort) return;
        this.abort = new AbortController();
        this.loopPromise = this.loop(this.abort.signal);
    }

    /**
     * Stop ticking and wait for whatever tick is currently in flight to finish. Safe to call when not
     * running. Waiting out the in-flight tick — rather than merely cancelling the timer — is what makes
     * "stopped" mean "will not write anything else", the same property `Poller.stop()` guarantees for
     * `SourcesModule`'s `shutdown` hook to rely on.
     */
    async stop(): Promise<void> {
        this.abort?.abort();
        await this.loopPromise;
        this.abort = undefined;
        this.loopPromise = undefined;
    }

    /**
     * Card 0271: on 2026-09-21 the compose stack restarted and the daemon died on `ECONNREFUSED`
     * thrown by `SettingsStore.get` from `BoundedCardStageJobRunner.watchConcurrency`
     * (`#modules/jobs/jobs.module.js`) — the interval read there sat outside any `try`, so a failing
     * read became an unhandled rejection that took the whole process down. Card 0257 fixed the
     * identical shape in `Poller.loop` (`#modules/jobs/poller.js`); this loop's own interval read had
     * the same gap, and this card closes it.
     *
     * A failing read is logged through `logger` and falls back to `lastIntervalMs`, the last interval
     * this loop successfully read, or `SOURCE_POLL_INTERVAL_MS_DEFAULT` when it has never read one —
     * so a database outage makes this loop wait and retry, never busy-loop, and never again take the
     * daemon with it. No reconnection logic: kysely's pool reconnects on the next query once Postgres
     * is back, which is why "keep looping" is the whole fix.
     */
    private async loop(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            // Read fresh on every iteration, not once at `start()` — the same reasoning `Poller.loop`
            // gives for `POLLER_INTERVAL_MS`: a row written mid-run changes the wait about to start.
            let intervalMs: number;
            try {
                intervalMs = await this.settings.get(SOURCE_POLL_INTERVAL_MS);
                this.lastIntervalMs = intervalMs;
            } catch (error) {
                this.logger.error(error);
                intervalMs = this.lastIntervalMs ?? SOURCE_POLL_INTERVAL_MS_DEFAULT;
            }
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
     * Every registered project, considered in turn — `Poller.tick`'s own shape. Lists projects fresh
     * every tick and re-registers each on `boardConfig`, cheap and idempotent, so a project added by
     * hand while the daemon is running is picked up without a restart. `projects` is optional, purely
     * so a test can construct a `SourcePoller` against a single fixed `BoardConfig`: `undefined` falls
     * back to the one project `boardConfig.project` already names.
     */
    private async tick(): Promise<void> {
        let names: string[];
        try {
            if (this.projects) {
                const rows = await this.projects.list();
                for (const row of rows) this.boardConfig.register(row);
                names = rows.map(row => row.name);
            } else {
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
                // A project whose own tick throws must not stop the walk over the other registered
                // projects in the same tick — log it and try again next interval, exactly as `Poller`
                // reasons about a single project's tick failing.
                this.logger.error(error);
            }
        }
    }

    /**
     * One project's tick: skip entirely unless `SOURCE_POLL_ENABLED`, then ask every registered source
     * what changed since its stored cursor, apply every reported item in order, and advance that
     * source's cursor only once the fetch reported `{ ok: true }`. Writes and logs nothing when there
     * is nothing to do — this runs forever, and an idle tick has to be cheap and silent.
     *
     * No dedup, deliberately: a repeat report of the same ref is already idempotent through
     * `InboundCardWriter`, which updates that card in place rather than creating a second one.
     */
    private async tickProject(): Promise<void> {
        const enabled = await this.settings.get(SOURCE_POLL_ENABLED);
        if (!enabled) return;

        for (const source of this.registry.list()) {
            try {
                const cursor = await this.cursors.get(source.name);
                const result = await source.changedSince(cursor);

                if (!result.ok) {
                    // A refusal is an ordinary code path (`CardSourceFetchResult` is a refusal shape,
                    // not a throw), not a reason to touch the stored cursor or stop the other sources.
                    this.logger.error(`source poll: ${source.name} refused: ${result.reason}`);
                    continue;
                }

                for (const item of result.items) {
                    await this.writer.apply(source.name, item);
                }
                await this.cursors.set(source.name, result.cursor);
            } catch (error) {
                // `CardSource.changedSince` documents itself as never throwing, but this poller does
                // not trust that at the boundary: a source that throws anyway must not stop the other
                // sources in the same tick, and must not stop the loop.
                this.logger.error(error);
            }
        }
    }
}
