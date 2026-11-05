import { Injectable } from 'injectkit';
import { Kysely, type Selectable } from 'kysely';
import { DateTime, Duration } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB, WilsonRuleProposals } from '#modules/data/db.js';

/** How long a person has to decide. Long enough to look at a batch of them, short enough not to pile up. */
export const RULE_PROPOSAL_LIFETIME = Duration.fromObject({ days: 45 });

export interface RuleProposal {
    id: string;
    cardId: string;
    statement: string;
    paths: string[];
    reason: string;
    expiresAt: DateTime;
    createdAt: DateTime;
}

const toProposal = (row: Selectable<WilsonRuleProposals>): RuleProposal => ({
    id: String(row.id),
    cardId: row.cardId,
    statement: row.statement ?? '',
    paths: row.paths ?? [],
    reason: row.reason ?? '',
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
});

/**
 * `wilson.rule_proposals`. See the migration (`20261104120200_rule_proposals.sql`) for the status flow.
 *
 * Every move out of 'pending' is one conditional UPDATE matching only a pending proposal not yet
 * expired, answering undefined when nothing matched. So a decision is at-most-once without a lock, the
 * way `ChatPendingActionRepository`'s are. A card's row is claimed before the model is asked, which is
 * what holds a card to one draft however many times it is sent back.
 */
@Injectable()
export class RuleProposalRepository {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {}

    /** Claim a card's one draft. False when something has already had it. */
    async claim(cardId: string): Promise<boolean> {
        const row = await this.db
            .insertInto('wilson.ruleProposals')
            .values({ project: this.config.project, cardId, status: 'drafting', expiresAt: DateTime.now().plus(RULE_PROPOSAL_LIFETIME) })
            .onConflict(oc => oc.columns(['project', 'cardId']).doNothing())
            .returning('id')
            .executeTakeFirst();
        return row !== undefined;
    }

    /** The drafted rule, now waiting on a person. */
    async propose(cardId: string, draft: { statement: string; paths: string[]; reason: string }): Promise<RuleProposal | undefined> {
        const row = await this.db
            .updateTable('wilson.ruleProposals')
            .set({ status: 'pending', ...draft, expiresAt: DateTime.now().plus(RULE_PROPOSAL_LIFETIME) })
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('status', '=', 'drafting')
            .returningAll()
            .executeTakeFirst();
        return row && toProposal(row);
    }

    /** No proposal came of this card's draft, and none will. */
    async skip(cardId: string, reason: string): Promise<void> {
        await this.db
            .updateTable('wilson.ruleProposals')
            .set({ status: 'skipped', reason })
            .where('project', '=', this.config.project)
            .where('cardId', '=', cardId)
            .where('status', '=', 'drafting')
            .execute();
    }

    /** What is waiting on a person, oldest first. */
    async pending(): Promise<RuleProposal[]> {
        const rows = await this.db
            .selectFrom('wilson.ruleProposals')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('status', '=', 'pending')
            .where('expiresAt', '>', DateTime.now())
            .orderBy('id')
            .execute();
        return rows.map(toProposal);
    }

    /** Take a pending, unexpired proposal to accept it. Undefined when it was not one, and the caller must not act. */
    async takeToAccept(id: string): Promise<RuleProposal | undefined> {
        return this.decide(id, 'accepted');
    }

    /** Put back a proposal whose rule turned out not to be writable, for the person to try again. */
    async release(id: string): Promise<void> {
        await this.db
            .updateTable('wilson.ruleProposals')
            .set({ status: 'pending', decidedAt: null })
            .where('project', '=', this.config.project)
            .where('id', '=', BigInt(id))
            .where('status', '=', 'accepted')
            .where('rule', 'is', null)
            .execute();
    }

    /** Say which rule an accepted proposal became. */
    async accepted(id: string, rule: string): Promise<void> {
        await this.db
            .updateTable('wilson.ruleProposals')
            .set({ rule })
            .where('project', '=', this.config.project)
            .where('id', '=', BigInt(id))
            .execute();
    }

    /** Decline a pending, unexpired proposal. Undefined when it was not one. */
    async decline(id: string): Promise<RuleProposal | undefined> {
        return this.decide(id, 'declined');
    }

    private async decide(id: string, status: 'accepted' | 'declined'): Promise<RuleProposal | undefined> {
        const now = DateTime.now();
        const row = await this.db
            .updateTable('wilson.ruleProposals')
            .set({ status, decidedAt: now })
            .where('project', '=', this.config.project)
            .where('id', '=', BigInt(id))
            .where('status', '=', 'pending')
            .where('expiresAt', '>', now)
            .returningAll()
            .executeTakeFirst();
        return row && toProposal(row);
    }
}
