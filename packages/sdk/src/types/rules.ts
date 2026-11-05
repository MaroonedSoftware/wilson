import { DateTime } from 'luxon';
import type { JsonValue } from '../sdk-options.js';

const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * `revision` is the newest `wilson.rule_revisions` id, which a verdict is keyed on.
 * generated from [Rule](../../../../apps/api/data/contracts/rules.ck)
 */
export interface Rule {
    id: string;
    statement: string;
    paths: string[];
    severity: 'blocker' | 'concern';
    revision: string;
    createdAt: DateTime;
    updatedAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a Rule into its runtime type. Mutates and returns `raw`. */
export function reviveRule(raw: Rule): Rule {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'Rule.createdAt');
    __o0['updatedAt'] = __dt(__o0['updatedAt'], 'Rule.updatedAt');
    return raw;
}

/**
 * generated from [CreateRuleRequest](../../../../apps/api/data/contracts/rules.ck)
 */
export interface CreateRuleRequest {
    id: string;
    statement: string;
    paths: string[];
    severity?: 'blocker' | 'concern';
    message?: string;
}

/**
 * Only what changes.
 * generated from [PatchRuleRequest](../../../../apps/api/data/contracts/rules.ck)
 */
export interface PatchRuleRequest {
    statement?: string;
    paths?: string[];
    severity?: 'blocker' | 'concern';
    message?: string;
}

/**
 * generated from [DeleteRuleQuery](../../../../apps/api/data/contracts/rules.ck)
 */
export interface DeleteRuleQuery {
    message?: string;
}

/**
 * One change to a rule. No `snapshot` means the rule was removed.
 * generated from [RuleRevision](../../../../apps/api/data/contracts/rules.ck)
 */
export interface RuleRevision {
    id: string;
    rule: string;
    snapshot?: JsonValue;
    message: string;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a RuleRevision into its runtime type. Mutates and returns `raw`. */
export function reviveRuleRevision(raw: RuleRevision): RuleRevision {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'RuleRevision.createdAt');
    return raw;
}

/**
 * generated from [RuleRevisionsQuery](../../../../apps/api/data/contracts/rules.ck)
 */
export interface RuleRevisionsQuery {
    rule?: string;
    limit?: number;
}

/**
 * What to check: `branch`'s diff from its merge base with `base`, which is what the project's code root
 * has checked out when left out.
 * generated from [RuleCheckRequest](../../../../apps/api/data/contracts/rules.ck)
 */
export interface RuleCheckRequest {
    branch: string;
    base?: string;
}

/**
 * generated from [RuleCheckVerdict](../../../../apps/api/data/contracts/rules.ck)
 */
export interface RuleCheckVerdict {
    rule: string;
    revision: string;
    statement: string;
    severity: 'blocker' | 'concern';
    paths: string[];
    verdict: 'pass' | 'fail' | 'unavailable';
    file?: string;
    line?: number;
    evidence: string;
    reused: boolean;
}

/**
 * generated from [RuleCheckUsage](../../../../apps/api/data/contracts/rules.ck)
 */
export interface RuleCheckUsage {
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens?: number;
}

/**
 * A rule a model drafted from a blocker that survived challenge and sent a card back. It is nothing until
 * a person accepts it, and stops being offered after 45 days.
 * generated from [RuleProposal](../../../../apps/api/data/contracts/rules.ck)
 */
export interface RuleProposal {
    id: string;
    cardId: string;
    statement: string;
    paths: string[];
    reason: string;
    expiresAt: DateTime;
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a RuleProposal into its runtime type. Mutates and returns `raw`. */
export function reviveRuleProposal(raw: RuleProposal): RuleProposal {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['expiresAt'] = __dt(__o0['expiresAt'], 'RuleProposal.expiresAt');
    __o0['createdAt'] = __dt(__o0['createdAt'], 'RuleProposal.createdAt');
    return raw;
}

/**
 * What the rule is called, which a person chooses, and any words they changed.
 * generated from [AcceptRuleProposalRequest](../../../../apps/api/data/contracts/rules.ck)
 */
export interface AcceptRuleProposalRequest {
    id: string;
    statement?: string;
    paths?: string[];
    severity?: 'blocker' | 'concern';
}

/**
 * generated from [RuleCheckReport](../../../../apps/api/data/contracts/rules.ck)
 */
export interface RuleCheckReport {
    branch: string;
    mergeBase: string;
    verdicts: RuleCheckVerdict[];
    usage?: RuleCheckUsage;
}
