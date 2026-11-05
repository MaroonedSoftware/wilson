import { Injectable } from 'injectkit';
import { DateTime, Duration } from 'luxon';
import { Job, type JobQueuePolicy, type JobWorkerPolicy } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import { runAsProject } from '#modules/board/project.context.js';
import { explainError } from '#modules/chat/chat.catalog.js';
import { ChatService } from '#modules/chat/chat.service.js';
import { GoalRepository, type Goal } from '#modules/goal/goal.repository.js';
import { MAX_WAKE_EVENTS, needsAttention, WAKE_EVENT_TYPES, WAKE_HOLD_MINUTES, WAKE_MAX_STEPS, wakeNote } from '#modules/goal/goal.wake.js';
import { orchestratorSession } from '#modules/goal/orchestrator.session.js';
import { ORCHESTRATOR_DAILY_OUTPUT_TOKENS, ORCHESTRATOR_ENABLED } from '#modules/settings/orchestrator.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { StageConfigStore } from '#modules/stages/stage.config.store.js';

export interface GoalWakePayload {
    goalId: string;
}

/**
 * No retries: a failed wake-up leaves its cursor where it was and holds its goal, and `GoalWatcher`
 * sends it again once the hold lapses. The expiry matches a long turn, not a queue hop.
 */
export const GOAL_WAKE_POLICY: JobQueuePolicy = {
    retryLimit: 0,
    expiresIn: Duration.fromObject({ hours: 1 }),
};

/** One at a time: each is a model turn nobody asked for, on the same engine accounts as stages. */
export const GOAL_WAKE_WORKER: JobWorkerPolicy = { concurrency: 1 };

/**
 * Tells one goal's thread what happened on its cards.
 *
 * The cursor moves only once the turn is stored, so a crash or a failed turn re-reads the same events
 * rather than losing them. A crash in the gap between the two says something twice, which is the cheap
 * side to be wrong on, and `findPending` keeps a proposal from doubling.
 *
 * Re-reads every setting here because any can have changed in the queue.
 */
@Injectable()
export class GoalWakeJob extends Job<GoalWakePayload> {
    constructor(
        private readonly goals: GoalRepository,
        private readonly chat: ChatService,
        private readonly settings: SettingsStore,
        private readonly stages: StageConfigStore,
        private readonly logger: Logger,
    ) {
        super();
    }

    async run({ goalId }: GoalWakePayload): Promise<void> {
        const goal = await this.goals.get(goalId);
        if (!goal || goal.status !== 'active') return;
        if (goal.wakeHeldUntil && goal.wakeHeldUntil > DateTime.now()) return;
        await runAsProject(goal.project, () => this.wake(goal));
    }

    private async wake(goal: Goal): Promise<void> {
        if (!(await this.settings.get(ORCHESTRATOR_ENABLED))) return;
        const spent = await this.goals.outputTokensSince(goal.project, DateTime.now().startOf('day'));
        if (spent >= (await this.settings.get(ORCHESTRATOR_DAILY_OUTPUT_TOKENS))) return;

        const events = await this.goals.eventsAfter(goal, WAKE_EVENT_TYPES, MAX_WAKE_EVENTS);
        const last = events.at(-1);
        if (!last) return;

        const stages = await this.stages.load();
        const attention = events.filter(event => needsAttention(event, stages));
        if (attention.length > 0) {
            try {
                await this.chat.runNote(goal.threadId, wakeNote(attention), orchestratorSession(), goal.project, { maxSteps: WAKE_MAX_STEPS });
            } catch (err) {
                this.logger.warn(`goal ${goal.id}: the wake-up failed, holding for ${WAKE_HOLD_MINUTES} minutes: ${explainError(err)}`);
                await this.goals.holdWake(goal.id, DateTime.now().plus({ minutes: WAKE_HOLD_MINUTES }));
                return;
            }
        }
        await this.goals.advanceCursor(goal.id, last.id);
    }
}
