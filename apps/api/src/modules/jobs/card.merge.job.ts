import { Injectable } from 'injectkit';
import { DateTime, Duration } from 'luxon';
import { Job, type JobQueuePolicy, type JobWorkerPolicy } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { BoardRepository } from '#modules/board/board.repository.js';
import { BoardWriteService } from '#modules/board/board.write.service.js';
import { runAsProject } from '#modules/board/project.context.js';
import { EventLog, type AppendableCardEventType } from '#modules/events/event.log.js';
import { DAILY_OUTPUT_TOKEN_CEILING } from '#modules/settings/daily.output.token.ceiling.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import { MAX_STAGE_WALL_CLOCK_MS } from '#modules/stages/stage.config.js';

export interface CardMergePayload {
    cardId: string;
    /** The project the card belongs to, carried for the reason `CardStagePayload.project` is. */
    project: string;
}

/**
 * `card.merge-skipped` belongs in the closed `CardEventType` union beside `card.plan-draft-skipped`,
 * but `card.event.ts` is outside card 0036's "Files in scope" — the same conflict `event.log.ts`'s
 * `AppendableCardEventType` records for `card.over-budget`. Stored as text like every other type, so
 * this only names it; a follow-up card can fold it into `CardEventType` and drop the cast.
 */
export const CARD_MERGE_SKIPPED = 'card.merge-skipped' as AppendableCardEventType;

/**
 * No retries: a merge a restart abandoned is simply attempted again by the next poller tick, because
 * the card is still sitting in `ready`, and re-delivering a half-finished merge is worse than that.
 *
 * The expiry is sized for `BoardWriteService.merge`'s own worst case, not a queue hop: a setup
 * command, the full suite (`testTimeoutMs` caps at `MAX_STAGE_WALL_CLOCK_MS`) and the one rerun
 * `judgeFailedMergeSuite` may give a red suite, plus headroom for the scratch worktree around them.
 */
export const CARD_MERGE_POLICY: JobQueuePolicy = {
    retryLimit: 0,
    expiresIn: Duration.fromMillis(MAX_STAGE_WALL_CLOCK_MS * 2).plus({ minutes: 10 }),
};

/** One at a time, so two `ready` cards never run a merge suite at once. */
export const CARD_MERGE_WORKER: JobWorkerPolicy = { concurrency: 1 };

/**
 * Card 0036. Merges one `ready` card the way `merge_card` does (`BoardWriteService.merge`): the card's
 * branch merged without a checkout, proved against the project's suite, landed only if it passes.
 * Queued by the poller, which never runs a merge inside a tick — a merge is minutes of work and a tick
 * must stay cheap. Every event the merge writes records `by: 'runner'`.
 *
 * Nothing here fails the job. Re-checks the card is still in `ready` and unflagged, and the project is
 * under its daily ceiling, because this runs after the tick that queued it and any of those can have
 * changed in the queue. A refusal, an unmerged result or a thrown error is appended as
 * `card.merge-skipped` with a reason; `merge` has already flagged the card `needsHuman` itself on a
 * conflict or a red suite.
 */
@Injectable()
export class CardMergeJob extends Job<CardMergePayload> {
    constructor(
        private readonly writes: BoardWriteService,
        private readonly board: BoardConfig,
        private readonly boardRepo: BoardRepository,
        private readonly events: EventLog,
        private readonly settings: SettingsStore,
        private readonly logger: Logger,
    ) {
        super();
    }

    async run({ cardId, project }: CardMergePayload): Promise<void> {
        await runAsProject(project, () => this.merge(cardId));
    }

    private async merge(cardId: string): Promise<void> {
        let skipped: string | undefined;
        try {
            skipped = await this.whyNot(cardId);
            if (!skipped) {
                const result = await this.writes.merge(cardId, { by: 'runner' });
                if (result.merged) {
                    this.logger.info(`merged ${cardId}${result.reason ? ` (${result.reason})` : ''}`);
                    return;
                }
                // A project that lands merges as pull requests: the merge did all it can, and the
                // card follows the pull request (`PullRequestWatcher`).
                if (result.pullRequest?.state === 'open') {
                    this.logger.info(`${cardId}: ${result.reason ?? `opened pull request #${result.pullRequest.number}`}`);
                    return;
                }
                skipped = result.reason ?? 'the merge did not land';
            }
        } catch (err) {
            const details = (err as { details?: { reason?: string } }).details;
            skipped = details?.reason ?? (err as Error).message;
        }

        this.logger.warn(`${cardId} not merged: ${skipped}`);
        await this.events.append({
            project: this.board.project,
            cardId,
            stage: 'ready',
            type: CARD_MERGE_SKIPPED,
            payload: { reason: skipped },
        });
    }

    private async whyNot(cardId: string): Promise<string | undefined> {
        const card = await this.boardRepo.read(cardId);
        if (card.frontmatter.stage !== 'ready') return `${cardId} is in "${card.frontmatter.stage}", not "ready"`;
        if (card.frontmatter.needsHuman) return `${cardId} is flagged for a human`;
        if (card.frontmatter.pullRequest?.state === 'open') return `${cardId} is waiting on pull request #${card.frontmatter.pullRequest.number}`;

        const ceiling = await this.settings.get(DAILY_OUTPUT_TOKEN_CEILING);
        if (ceiling <= 0) return undefined;
        const spent = await this.events.outputTokensSince(this.board.project, DateTime.now().startOf('day'));
        return spent >= ceiling
            ? `${this.board.project} has spent ${spent} output tokens today, at or over its daily ceiling of ${ceiling}`
            : undefined;
    }
}
