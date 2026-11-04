import { httpError } from '@maroonedsoftware/errors';
import { Injectable } from 'injectkit';
import type { CreateRuleRequest, DeleteRuleQuery, PatchRuleRequest, Rule, RuleRevision, RuleRevisionsQuery } from '../../generated/rules.js';
import { RuleRefusedError, RuleStore } from './rule.store.js';

/** The most revisions one request returns, and the default: the same numbers `StageConfigService` uses. */
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 200;

/** A refusal as the status it means, with the store's own sentence as the reason. */
const refusal = (err: unknown): unknown => {
    if (!(err instanceof RuleRefusedError)) return err;
    const status = err.kind === 'not-found' ? 404 : err.kind === 'duplicate' ? 409 : 400;
    return httpError(status).withDetails({ reason: err.message });
};

/**
 * The rules' read and write surface: the service `rules.ck`'s operations bind to, over `RuleStore`,
 * which validates on write and keeps the history. Thin for the reason `StageConfigService` is.
 */
@Injectable()
export class RulesService {
    constructor(private readonly rules: RuleStore) {}

    async list(): Promise<Rule[]> {
        return (await this.rules.list()) as Rule[];
    }

    async create(body: CreateRuleRequest): Promise<Rule> {
        const { id, statement, paths, severity = 'blocker', message } = body;
        try {
            return (await this.rules.create(id, { statement, paths, severity }, message?.trim() || `Added ${id}`)) as Rule;
        } catch (err) {
            throw refusal(err);
        }
    }

    async update(id: string, body: PatchRuleRequest): Promise<Rule> {
        const { message, ...patch } = body;
        try {
            return (await this.rules.update(id, patch, message?.trim() || `Edited ${id}`)) as Rule;
        } catch (err) {
            throw refusal(err);
        }
    }

    async remove(id: string, query: DeleteRuleQuery): Promise<void> {
        try {
            await this.rules.remove(id, query.message?.trim() || `Removed ${id}`);
        } catch (err) {
            throw refusal(err);
        }
    }

    async revisions(query: RuleRevisionsQuery): Promise<RuleRevision[]> {
        const limit = Math.min(query.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
        return (await this.rules.revisions(query.rule, limit)) as RuleRevision[];
    }
}
