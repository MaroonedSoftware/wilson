import { Injectable } from 'injectkit';
import { DateTime, Duration } from 'luxon';
import { Job, type JobQueuePolicy, type JobWorkerPolicy } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { runAsProject } from '#modules/board/project.context.js';
import { EventLog } from '#modules/events/event.log.js';
import { Notifier } from '#modules/notify/notifier.js';
import { PlanService } from '#modules/plan/plan.service.js';
import { AUTO_SPLIT_ENABLED } from '#modules/settings/auto.split.setting.js';
import { DAILY_OUTPUT_TOKEN_CEILING } from '#modules/settings/daily.output.token.ceiling.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';

export interface PlanDraftPayload {
    cardId: string;
    /** The project the card belongs to, carried for the reason `CardStagePayload.project` is. */
    project: string;
}

/**
 * No retries: a failed draft is not worth a second model run, and the piece is no worse off than one
 * nobody drafted. The expiry matches a long planning turn, not a queue hop.
 */
export const PLAN_DRAFT_POLICY: JobQueuePolicy = {
    retryLimit: 0,
    expiresIn: Duration.fromObject({ hours: 1 }),
};

/** One at a time: a split can enqueue several, and each is a model run no local stage slot accounts for. */
export const PLAN_DRAFT_WORKER: JobWorkerPolicy = { concurrency: 1 };

/**
 * Drafts the plan of one piece an automatic split created (`PlanService.autoDraft`), so a person
 * meets a plan to approve rather than a stub. Approval stays theirs: the piece never leaves
 * `planning` here, which is also what keeps a chain of splits from running with nobody looking.
 *
 * Nothing here fails the job. A piece that gets no plan is a piece waiting in `planning`, as it would
 * be with drafting off, and `card.plan-draft-skipped` says why. Re-reads the setting and the daily
 * ceiling because this runs after the refusal, and either can have changed in the queue.
 */
@Injectable()
export class PlanDraftJob extends Job<PlanDraftPayload> {
    constructor(
        private readonly plans: PlanService,
        private readonly board: BoardConfig,
        private readonly boardRepo: BoardRepository,
        private readonly events: EventLog,
        private readonly settings: SettingsStore,
        private readonly logger: Logger,
    ) {
        super();
    }

    async run({ cardId, project }: PlanDraftPayload): Promise<void> {
        await runAsProject(project, () => this.draft(cardId));
    }

    private async draft(cardId: string): Promise<void> {
        let skipped = await this.whyNot();
        if (!skipped) {
            try {
                skipped = await this.plans.autoDraft(cardId);
            } catch (err) {
                const details = (err as { details?: { reason?: string } }).details;
                skipped = details?.reason ?? (err as Error).message;
            }
        }

        if (skipped) {
            this.logger.warn(`no plan drafted for ${cardId}: ${skipped}`);
            await this.events.append({
                project: this.board.project,
                cardId,
                stage: 'planning',
                type: 'card.plan-draft-skipped',
                payload: { reason: skipped },
            });
            return;
        }

        await this.events.append({ project: this.board.project, cardId, stage: 'planning', type: 'card.plan-drafted', payload: {} });
        await this.notifyDrafted(cardId);
    }

    private async whyNot(): Promise<string | undefined> {
        if (!(await this.settings.get(AUTO_SPLIT_ENABLED))) return 'auto-split was turned off';

        const ceiling = await this.settings.get(DAILY_OUTPUT_TOKEN_CEILING);
        if (ceiling <= 0) return undefined;
        const spent = await this.events.outputTokensSince(this.board.project, DateTime.now().startOf('day'));
        return spent >= ceiling
            ? `${this.board.project} has spent ${spent} output tokens today, at or over its daily ceiling of ${ceiling}`
            : undefined;
    }

    /** The card now waits at a manual gate with a plan to read, so this is that moment. */
    private async notifyDrafted(cardId: string): Promise<void> {
        if (!this.board.notifyWebhookUrl) return;

        const card = await this.boardRepo.read(cardId).catch(() => undefined);
        await new Notifier(this.board.notifyWebhookUrl, this.board.notifyBaseUrl).notify({
            project: this.board.project,
            cardId,
            title: card?.frontmatter.title ?? cardId,
            stage: 'planning',
            moment: 'manual',
            reason: 'plan drafted, waiting for approval',
        });
    }
}
