import { setTimeout as delay } from 'node:timers/promises';
import type { Kysely } from 'kysely';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { runAsProject } from '#modules/board/project.context.js';
import { ProjectRepository } from '#modules/board/project.repository.js';
import type { DB } from '#modules/data/db.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { STATUS_MIRROR_ENABLED } from '#modules/settings/status.mirror.enabled.setting.js';
import { STATUS_MIRROR_INTERVAL_MS, STATUS_MIRROR_INTERVAL_MS_DEFAULT } from '#modules/settings/status.mirror.interval.setting.js';
import type { MirrorMoment, MirrorStatus } from './card.source.js';
import { CardSourceRegistry } from './card.source.registry.js';
import { SourceCursorRepository } from './source.cursor.repository.js';

/**
 * The reserved `SourceCursorRepository` key this poller's own cursor is stored under — not a real
 * source name, the same sentinel-string idiom `SettingsStore` uses for `DEPLOYMENT_SCOPE`
 * (`settings.store.ts`). `SourceCursorRepository`'s `(project, source) -> opaque string` shape (its
 * own doc comment describes only the inbound case, one `CardSource`'s place in `changedSince`) covers
 * this without a schema change: the "source" here is not a `CardSource` at all, it is a cursor over
 * `runner.card_events` itself, and the stored value is that table's own `id`, not anything a
 * `CardSource.changedSince` produced.
 */
export const STATUS_MIRROR_CURSOR_KEY = '__status-mirror__';

/** One row of `runner.card_events`, narrowed to what {@link mirroredMoment} and `mirrorOne` need. */
interface MirroredTransitionRow {
    readonly id: string;
    readonly cardId: string;
    readonly payload: Record<string, unknown>;
}

/**
 * Which of the five moments this card's Constraints name `payload` (a `transition.written` event's
 * own payload — `StageDispatcher.writeTransition`/`refuseOverBudget`/`InboundCardWriter.applyClosed`
 * are its three writers) reaches, or `undefined` for every other transition, which stays unmirrored:
 * an internal handoff (`scope-check` passing, `implementing` handing to `testing`, `testing` handing
 * to `review`), and a kickback landing back on `implementing` from `testing` or `review` rather than
 * from a genuine `scope-check` pass.
 *
 * `needsHuman` is checked first, but the five conditions are mutually exclusive in practice: `kickback`
 * (`stages/kickback.ts`) only ever sets it on a self-loop (`target: stage.name`), never alongside a
 * `to` of `'ready'`, `'merged'`, or `'dropped'`.
 */
const mirroredMoment = (payload: Record<string, unknown>): MirrorMoment | undefined => {
    if (payload.needsHuman === true) return 'needs-human';
    if (payload.from === 'scope-check' && payload.to === 'implementing') return 'started';
    if (payload.to === 'ready') return 'ready';
    if (payload.to === 'merged') return 'merged';
    if (payload.to === 'dropped') return 'dropped';
    return undefined;
};

/**
 * The third, independent loop in `SourcesModule` (card 0201): on an interval, walk new
 * `transition.written` events for cards carrying an `external` ref, and report the five human-
 * meaningful ones ({@link mirroredMoment}) to that ref's source via `CardSource.mirrorStatus`.
 *
 * Outward only, and never a source of truth (PROJECT.md's "Card sources" — "one-way authority with
 * two-way data"): nothing a source's `mirrorStatus` returns is ever consulted for board state.
 * Mirroring is best-effort, the same posture `reclaimIfTerminal` takes on worktree reclamation — a
 * refusal (`{ ok: false }`) is logged and tolerated, never retried inline, and never unwinds the
 * transition that already committed. At-least-once, not exactly-once: a crash after posting a
 * comment but before advancing the cursor reposts that comment next tick, which this card's
 * Constraints accept as far cheaper than a missed one.
 *
 * Mirrors `SourcePoller`'s own shape (`source.poller.ts`) deliberately, per this card's Constraints:
 * the interval re-read fresh at the top of every iteration (not once at `start()`), an
 * `AbortController`, a `loopPromise` `stop()` awaits, every registered project walked inside
 * `runAsProject`, and silent when there is nothing new. A third loop beside `SourcePoller` and
 * `Poller`, never a branch inside either — each of the three now ticks for a different reason
 * (dispatching board work, importing tickets, mirroring status outward), and folding any two together
 * would give one class two reasons to run on one interval.
 *
 * Unlike `SourcePoller`, this reads `runner.card_events` directly via the injected `Kysely<DB>` pool
 * rather than through `EventLog` — `modules/events/` is outside this card's "Files in scope" — the
 * same reason `SourceCursorRepository` and `PostgresCacheProvider` are constructed with the pool
 * directly instead of resolving a repository that does not expose this query.
 */
export class StatusMirrorPoller {
    private abort: AbortController | undefined;
    private loopPromise: Promise<void> | undefined;
    // Last interval `loop` successfully read from `settings`, so a failing read has something better
    // than `STATUS_MIRROR_INTERVAL_MS_DEFAULT` to fall back to. See `loop`'s own doc comment (card 0271).
    private lastIntervalMs: number | undefined;

    constructor(
        private readonly registry: CardSourceRegistry,
        private readonly cursors: SourceCursorRepository,
        private readonly board: BoardRepository,
        private readonly boardConfig: BoardConfig,
        private readonly settings: SettingsStore,
        private readonly db: Kysely<DB>,
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
     * running. `SourcesModule`'s `shutdown` hook relies on this the same way it relies on
     * `SourcePoller.stop()`: "stopped" means "will not write anything else".
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
     * this loop successfully read, or `STATUS_MIRROR_INTERVAL_MS_DEFAULT` when it has never read one —
     * so a database outage makes this loop wait and retry, never busy-loop, and never again take the
     * daemon with it. No reconnection logic: kysely's pool reconnects on the next query once Postgres
     * is back, which is why "keep looping" is the whole fix.
     */
    private async loop(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            // Read fresh on every iteration, not once at `start()` — `SourcePoller.loop`'s own
            // reasoning for `SOURCE_POLL_INTERVAL_MS`: a row written mid-run changes the wait about
            // to start.
            let intervalMs: number;
            try {
                intervalMs = await this.settings.get(STATUS_MIRROR_INTERVAL_MS);
                this.lastIntervalMs = intervalMs;
            } catch (error) {
                this.logger.error(error);
                intervalMs = this.lastIntervalMs ?? STATUS_MIRROR_INTERVAL_MS_DEFAULT;
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
     * Every registered project, considered in turn — `SourcePoller.tick`'s own shape. Lists projects
     * fresh every tick and re-registers each on `boardConfig`, cheap and idempotent, so a project
     * added by hand while the daemon is running is picked up without a restart.
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
                // projects in the same tick — log it and try again next interval, `SourcePoller`'s own
                // reasoning.
                this.logger.error(error);
            }
        }
    }

    /**
     * One project's tick: skip entirely unless `STATUS_MIRROR_ENABLED`, then walk every
     * `transition.written` event past the stored cursor, in ascending order, mirroring each one and
     * advancing the cursor past its `id` regardless of whether the mirror call succeeded — a refusal
     * is logged and tolerated, not retried inline, exactly as a `changedSince` refusal already is in
     * `SourcePoller`.
     */
    private async tickProject(): Promise<void> {
        const enabled = await this.settings.get(STATUS_MIRROR_ENABLED);
        if (!enabled) return;

        const cursor = await this.cursors.get(STATUS_MIRROR_CURSOR_KEY);
        const events = await this.transitionsSince(cursor);

        for (const event of events) {
            try {
                await this.mirrorOne(event);
            } catch (error) {
                // Never trusted to keep its own "never throws" promise at the boundary, the same
                // posture `SourcePoller.tickProject` takes toward `CardSource.changedSince`: a card
                // read that fails, or a source that throws anyway, must not stop the walk over the
                // rest of this tick's events, and must not stop the loop.
                this.logger.error(error);
            }
            // Advanced per event, not once after the whole batch (unlike `SourcePoller`'s per-source
            // cursor): each event is its own unit of "already reported", so a crash partway through a
            // long batch never re-mirrors an event this tick already got past.
            await this.cursors.set(STATUS_MIRROR_CURSOR_KEY, event.id);
        }
    }

    /**
     * One `transition.written` event: skip silently unless its payload reaches one of the five
     * mirrored moments, skip the card if it carries no `external` ref, and otherwise call
     * `mirrorStatus` on every registered source named under a key that ref carries.
     */
    private async mirrorOne(event: MirroredTransitionRow): Promise<void> {
        const moment = mirroredMoment(event.payload);
        if (!moment) return;

        const card = await this.board.read(event.cardId);
        const external = card.frontmatter.external;
        if (!external) return;

        const status: MirrorStatus = {
            moment,
            cardId: card.frontmatter.id,
            title: card.frontmatter.title,
            // Only ever set for the one moment that carries a reason — `needsHumanReason` is runner
            // state on the card itself, not something this event's payload carries (this card's
            // Constraints: a source composes its own fixed sentence and never sees this forwarded
            // verbatim anyway).
            ...(moment === 'needs-human' && card.frontmatter.needsHumanReason ? { reason: card.frontmatter.needsHumanReason } : {}),
        };

        // `CardSourceRegistry.list()`, not `.resolve()` per key: a ref naming a source this project
        // has not registered (or one that implements no `mirrorStatus`) is ordinary, not a refusal
        // worth logging the way an unresolved `resolve()` call would be.
        for (const source of this.registry.list()) {
            if (!Object.prototype.hasOwnProperty.call(external, source.name) || !source.mirrorStatus) continue;

            const result = await source.mirrorStatus(external[source.name]!, status);
            if (!result.ok) {
                this.logger.error(`status mirror: ${source.name} refused for ${card.frontmatter.id}: ${result.reason}`);
            }
        }
    }

    /** `transition.written` events for the current project, `id` past `cursor`, oldest first. */
    private async transitionsSince(cursor: string | undefined): Promise<MirroredTransitionRow[]> {
        let query = this.db
            .selectFrom('runner.cardEvents')
            .select(['id', 'cardId', 'payload'])
            .where('project', '=', this.boardConfig.project)
            .where('type', '=', 'transition.written')
            .orderBy('id', 'asc');

        if (cursor !== undefined) {
            query = query.where('id', '>', cursor);
        }

        const rows = await query.execute();
        return rows.map(row => ({
            id: String(row.id),
            cardId: row.cardId,
            payload: (row.payload ?? {}) as Record<string, unknown>,
        }));
    }
}
