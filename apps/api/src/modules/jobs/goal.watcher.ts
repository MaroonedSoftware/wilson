import { setTimeout as delay } from 'node:timers/promises';
import { Injectable } from 'injectkit';
import { DateTime } from 'luxon';
import { JobBroker } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import { runAsProject } from '#modules/board/project.context.js';
import { GoalRepository, type Goal } from '#modules/goal/goal.repository.js';
import { WAKE_EVENT_TYPES } from '#modules/goal/goal.wake.js';
import { ORCHESTRATOR_DAILY_OUTPUT_TOKENS, ORCHESTRATOR_ENABLED } from '#modules/settings/orchestrator.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';

/** How often goals are checked. Events gather meanwhile, so a burst on one card becomes one wake-up. */
export const GOAL_WATCH_INTERVAL_MS = 60_000;

/** A job in these states is still going to read its goal's events, so another would find nothing. */
const UNFINISHED = new Set(['created', 'retry', 'active']);

/**
 * Sends a `goal.wake` for each goal with unread events on its cards.
 *
 * Reads a cursor rather than following `NOTIFY`, which a restart loses (PROJECT.md, Orchestration), and
 * does no model work, so it is cheap enough to run whether or not any project has turned this on. It
 * is separate from `Poller` because it must not depend on Auto-mode: a board nobody is dispatching can
 * still have cards that need a person.
 *
 * Which events deserve a turn is `GoalWakeJob`'s question, since answering it means loading the lanes.
 * A job for events that do not deserve one moves the cursor and costs nothing.
 */
@Injectable()
export class GoalWatcher {
    private abort?: AbortController;
    private loopPromise?: Promise<void>;
    /** The last job sent for each goal. Lost in a restart, when at worst one wake-up finds nothing to read. */
    private readonly sent = new Map<string, string>();
    /** The projects already warned of reaching their ceiling, and on which day, so a full day is one line. */
    private readonly warned = new Map<string, string>();

    constructor(
        private readonly goals: GoalRepository,
        private readonly broker: JobBroker,
        private readonly settings: SettingsStore,
        private readonly logger: Logger,
    ) {}

    /** Idempotent: calling `start` while already running does nothing. */
    start(): void {
        if (this.abort) return;
        this.abort = new AbortController();
        this.loopPromise = this.loop(this.abort.signal);
    }

    /** Stop ticking and wait out any tick in flight, so nothing is sent once this resolves. Safe when not running. */
    async stop(): Promise<void> {
        this.abort?.abort();
        await this.loopPromise;
        this.abort = undefined;
        this.loopPromise = undefined;
    }

    private async loop(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            try {
                await delay(GOAL_WATCH_INTERVAL_MS, undefined, { signal });
            } catch {
                return;
            }
            await this.tick();
        }
    }

    /** One pass over every goal. A goal or a read that fails is logged and left for the next tick, as `Poller.tick` does. */
    async tick(): Promise<void> {
        let goals: Goal[];
        try {
            goals = await this.goals.wakeable();
        } catch (error) {
            this.logger.error(error);
            return;
        }
        for (const goal of goals) {
            try {
                await runAsProject(goal.project, () => this.consider(goal));
            } catch (error) {
                this.logger.error(error);
            }
        }
    }

    private async consider(goal: Goal): Promise<void> {
        if (!(await this.settings.get(ORCHESTRATOR_ENABLED))) return;
        if ((await this.goals.eventsAfter(goal, WAKE_EVENT_TYPES, 1)).length === 0) return;
        if (await this.atCeiling(goal.project)) return;
        if (await this.alreadySent(goal.id)) return;
        this.sent.set(goal.id, await this.broker.send('goal.wake', { goalId: goal.id }));
    }

    private async atCeiling(project: string): Promise<boolean> {
        const ceiling = await this.settings.get(ORCHESTRATOR_DAILY_OUTPUT_TOKENS);
        const today = DateTime.now().startOf('day');
        const spent = await this.goals.outputTokensSince(project, today);
        if (spent < ceiling) return false;
        const day = today.toISODate() ?? '';
        if (this.warned.get(project) !== day) {
            this.warned.set(project, day);
            this.logger.warn(
                `goals in ${project} have spent ${spent} output tokens today, at or past their ceiling of ${ceiling}; wake-ups resume tomorrow`,
            );
        }
        return true;
    }

    private async alreadySent(goalId: string): Promise<boolean> {
        const jobId = this.sent.get(goalId);
        if (!jobId) return false;
        const job = await this.broker.getJob('goal.wake', jobId);
        return job !== null && job !== undefined && UNFINISHED.has(job.state);
    }
}
