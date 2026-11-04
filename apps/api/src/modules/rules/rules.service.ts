import { httpError } from '@maroonedsoftware/errors';
import { Injectable } from 'injectkit';
import { BoardConfig } from '#modules/board/board.config.js';
import { git } from '#modules/board/git.js';
import { localHost } from '#modules/host/local.execution.host.js';
import type {
    CreateRuleRequest,
    DeleteRuleQuery,
    PatchRuleRequest,
    Rule,
    RuleCheckReport,
    RuleCheckRequest,
    RuleRevision,
    RuleRevisionsQuery,
} from '../../generated/rules.js';
import { RuleJudge } from './rule.judge.js';
import { RuleRefusedError, RuleStore } from './rule.store.js';

/**
 * How long a check may take. A person's client is waiting on the response, and Node's `fetch` gives up
 * on one with no headers after five minutes, so an answer has to come before that.
 */
export const RULE_CHECK_DEADLINE_MS = 4 * 60 * 1000;

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
    constructor(
        private readonly rules: RuleStore,
        private readonly judge: RuleJudge,
        private readonly config: BoardConfig,
    ) {}

    /**
     * Judge the project's matching rules against a branch's diff from its merge base, as a review would.
     * It writes verdicts, so a card over the same code gets them for free, and nothing on the board moves.
     */
    async check({ branch, base = 'HEAD' }: RuleCheckRequest): Promise<RuleCheckReport> {
        const cwd = this.config.codeRoot;
        const branchSha = await this.commitOf(cwd, branch);
        const baseSha = await this.commitOf(cwd, base);
        const mergeBase = (await git(cwd, ['merge-base', baseSha, branchSha])).stdout.trim();
        const { verdicts, usage } = await this.judge.judge({
            rules: await this.rules.list(),
            host: localHost,
            cwd,
            range: [mergeBase, branchSha],
            deadlineMs: RULE_CHECK_DEADLINE_MS,
        });
        return { branch, mergeBase, verdicts, ...(usage ? { usage } : {}) };
    }

    private async commitOf(cwd: string, ref: string): Promise<string> {
        try {
            return (await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).stdout.trim();
        } catch {
            throw httpError(400).withDetails({ reason: `there is no branch or commit "${ref}"` });
        }
    }

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
