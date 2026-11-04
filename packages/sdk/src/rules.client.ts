import type {
    AcceptRuleProposalRequest,
    CreateRuleRequest,
    DeleteRuleQuery,
    PatchRuleRequest,
    Rule,
    RuleCheckReport,
    RuleCheckRequest,
    RuleProposal,
    RuleRevision,
    RuleRevisionsQuery,
} from './types/rules.js';
import { reviveRule, reviveRuleProposal, reviveRuleRevision } from './types/rules.js';
import type { SdkFetch } from './sdk-options.js';
import { bigIntReplacer, parseJson, buildQueryString } from './sdk-options.js';

/**
 * generated from [rules.ck](../../../apps/api/data/contracts/rules.ck)
 */
export class RulesClient {
    constructor(private fetch: SdkFetch) {}

    /** @name List rules */
    async listRules(): Promise<Rule[]> {
        const result = await this.fetch(`/api/rules`, { method: 'GET' });
        return (await parseJson<Rule[]>(result)).map(reviveRule);
    }

    /** @name Create rule */
    async createRule(body: CreateRuleRequest): Promise<Rule> {
        const result = await this.fetch(`/api/rules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveRule(await parseJson<Rule>(result));
    }

    /** @name List rule proposals */
    async listRuleProposals(): Promise<RuleProposal[]> {
        const result = await this.fetch(`/api/rules/proposals`, { method: 'GET' });
        return (await parseJson<RuleProposal[]>(result)).map(reviveRuleProposal);
    }

    /** @name Accept rule proposal */
    async acceptRuleProposal(id: string, body: AcceptRuleProposalRequest): Promise<Rule> {
        const result = await this.fetch(`/api/rules/proposals/${encodeURIComponent(id)}/accept`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveRule(await parseJson<Rule>(result));
    }

    /** @name Decline rule proposal */
    async declineRuleProposal(id: string): Promise<void> {
        await this.fetch(`/api/rules/proposals/${encodeURIComponent(id)}/decline`, { method: 'POST' });
    }

    /** @name Check rules */
    async checkRules(body: RuleCheckRequest): Promise<RuleCheckReport> {
        const result = await this.fetch(`/api/rules/check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return await parseJson<RuleCheckReport>(result);
    }

    /** @name List rule revisions */
    async listRuleRevisions(query?: RuleRevisionsQuery): Promise<RuleRevision[]> {
        const qs = buildQueryString(query);
        const result = await this.fetch(`/api/rules/revisions${qs}`, {
            method: 'GET',
        });
        return (await parseJson<RuleRevision[]>(result)).map(reviveRuleRevision);
    }

    /** @name Update rule */
    async updateRule(id: string, body: PatchRuleRequest): Promise<Rule> {
        const result = await this.fetch(`/api/rules/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body, bigIntReplacer),
        });
        return reviveRule(await parseJson<Rule>(result));
    }

    /** @name Delete rule */
    async deleteRule(id: string, query?: DeleteRuleQuery): Promise<void> {
        const qs = buildQueryString(query);
        await this.fetch(`/api/rules/${encodeURIComponent(id)}${qs}`, {
            method: 'DELETE',
        });
    }
}
