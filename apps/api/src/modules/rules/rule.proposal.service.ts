import { httpError } from '@maroonedsoftware/errors';
import { Injectable } from 'injectkit';
import type { AcceptRuleProposalRequest, Rule, RuleProposal } from '../../generated/rules.js';
import { RuleProposalRepository } from './rule.proposal.repository.js';
import { RuleRefusedError, RuleStore } from './rule.store.js';

const gone = (id: string): unknown =>
    httpError(409).withDetails({ reason: `proposal ${id} is not waiting on a decision: it was decided, or it expired` });

/**
 * A person's decision on a proposed rule (`rules.ck`). The only way a proposal becomes a rule is through
 * `accept`, behind the same step-up any other rule write needs.
 */
@Injectable()
export class RuleProposalService {
    constructor(
        private readonly proposals: RuleProposalRepository,
        private readonly rules: RuleStore,
    ) {}

    async list(): Promise<RuleProposal[]> {
        return (await this.proposals.pending()) as RuleProposal[];
    }

    /**
     * Taken first, so two accepts cannot both write a rule. A rule that cannot be written, a taken id
     * say, puts the proposal back for the person to try again rather than losing it.
     */
    async accept(id: string, body: AcceptRuleProposalRequest): Promise<Rule> {
        const proposal = await this.proposals.takeToAccept(id);
        if (!proposal) throw gone(id);
        try {
            const rule = await this.rules.create(
                body.id,
                { statement: body.statement ?? proposal.statement, paths: body.paths ?? proposal.paths, severity: body.severity ?? 'blocker' },
                `Accepted the rule proposed from card ${proposal.cardId}`,
            );
            await this.proposals.accepted(id, rule.id);
            return rule as Rule;
        } catch (err) {
            await this.proposals.release(id);
            if (!(err instanceof RuleRefusedError)) throw err;
            throw httpError(err.kind === 'duplicate' ? 409 : 400).withDetails({ reason: err.message });
        }
    }

    async decline(id: string): Promise<void> {
        if (!(await this.proposals.decline(id))) throw gone(id);
    }
}
