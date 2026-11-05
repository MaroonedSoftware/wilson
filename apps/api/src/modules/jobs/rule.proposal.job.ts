import { Injectable } from 'injectkit';
import { DateTime, Duration } from 'luxon';
import { Job, type JobQueuePolicy, type JobWorkerPolicy } from '@maroonedsoftware/jobbroker';
import { Logger } from '@maroonedsoftware/logger';
import { BoardConfig } from '#modules/board/board.config.js';
import { runAsProject } from '#modules/board/project.context.js';
import { EventLog } from '#modules/events/event.log.js';
import { RuleProposalDrafter } from '#modules/rules/rule.proposal.drafter.js';
import { RuleProposalRepository } from '#modules/rules/rule.proposal.repository.js';
import { DAILY_OUTPUT_TOKEN_CEILING } from '#modules/settings/daily.output.token.ceiling.setting.js';
import { SettingsStore } from '#modules/settings/settings.store.js';
import type { ReviewFinding } from '#modules/stages/stage.result.js';

export interface RuleProposalPayload {
    cardId: string;
    /** The project the card belongs to, carried for the reason `CardStagePayload.project` is. */
    project: string;
    /** What a challenge upheld and sent back. */
    blockers: ReviewFinding[];
}

/** No retries: a failed draft is not worth a second model run, and a card is no worse off without one. */
export const RULE_PROPOSAL_POLICY: JobQueuePolicy = {
    retryLimit: 0,
    expiresIn: Duration.fromObject({ minutes: 15 }),
};

/** One at a time: each is a model run no local stage slot accounts for. */
export const RULE_PROPOSAL_WORKER: JobWorkerPolicy = { concurrency: 1 };

/**
 * Has a kickback's upheld blockers looked at for a rule worth checking from now on. A card gets one look
 * however many times it is sent back, which with a person having to confirm each is what keeps these
 * from flooding the queue. Nothing here fails the job or moves the card.
 */
@Injectable()
export class RuleProposalJob extends Job<RuleProposalPayload> {
    constructor(
        private readonly proposals: RuleProposalRepository,
        private readonly drafter: RuleProposalDrafter,
        private readonly board: BoardConfig,
        private readonly events: EventLog,
        private readonly settings: SettingsStore,
        private readonly logger: Logger,
    ) {
        super();
    }

    async run({ cardId, project, blockers }: RuleProposalPayload): Promise<void> {
        await runAsProject(project, () => this.propose(cardId, blockers));
    }

    private async propose(cardId: string, blockers: ReviewFinding[]): Promise<void> {
        // Before claiming: a card turned away by the ceiling today can still have its look next time.
        if (await this.overCeiling()) {
            this.logger.warn(`no rule proposed from ${cardId}: ${this.board.project} is at its daily output ceiling`);
            return;
        }
        if (!(await this.proposals.claim(cardId))) return;

        const draft = await this.drafter.draft(blockers);
        const usage = draft.usage ? { usage: draft.usage } : {};
        const append = (payload: Record<string, unknown>) =>
            this.events.append({ project: this.board.project, cardId, stage: 'review', type: 'rule.proposed', payload: { ...payload, ...usage } });

        if ('skipped' in draft) {
            await this.proposals.skip(cardId, draft.skipped);
            await append({ reason: draft.skipped });
            return;
        }
        const proposal = await this.proposals.propose(cardId, draft.proposed);
        await append({ proposal: proposal?.id, statement: draft.proposed.statement });
    }

    private async overCeiling(): Promise<boolean> {
        const ceiling = await this.settings.get(DAILY_OUTPUT_TOKEN_CEILING);
        if (ceiling <= 0) return false;
        return (await this.events.outputTokensSince(this.board.project, DateTime.now().startOf('day'))) >= ceiling;
    }
}
