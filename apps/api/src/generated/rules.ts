import { z } from 'zod';
import { DateTime } from 'luxon';

const _ZodDatetime = z.preprocess(
    val => (typeof val === 'string' ? DateTime.fromISO(val) : val),
    z.custom<DateTime>(val => val instanceof DateTime && val.isValid, { message: 'Must be in ISO 8601 format' }),
);
type _JsonValue = string | number | boolean | null | _JsonValue[] | { [key: string]: _JsonValue };
const _ZodJson: z.ZodType<_JsonValue> = z.lazy(() =>
    z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(_ZodJson), z.record(z.string(), _ZodJson)]),
);

/**
 * `revision` is the newest `wilson.rule_revisions` id, which a verdict is keyed on.
 * generated from [Rule](../../data/contracts/rules.ck)
 */
export const Rule = z.strictObject({
    id: z.string(),
    statement: z.string(),
    paths: z.array(z.string()),
    severity: z.enum(['blocker', 'concern']),
    revision: z.string(),
    createdAt: _ZodDatetime,
    updatedAt: _ZodDatetime,
});
export type Rule = z.infer<typeof Rule>;

/**
 * generated from [CreateRuleRequest](../../data/contracts/rules.ck)
 */
export const CreateRuleRequest = z.strictObject({
    id: z.string(),
    statement: z.string(),
    paths: z.array(z.string()),
    severity: z.enum(['blocker', 'concern']).optional(),
    message: z.string().optional(),
});
export type CreateRuleRequest = z.infer<typeof CreateRuleRequest>;

/**
 * Only what changes.
 * generated from [PatchRuleRequest](../../data/contracts/rules.ck)
 */
export const PatchRuleRequest = z.strictObject({
    statement: z.string().optional(),
    paths: z.array(z.string()).optional(),
    severity: z.enum(['blocker', 'concern']).optional(),
    message: z.string().optional(),
});
export type PatchRuleRequest = z.infer<typeof PatchRuleRequest>;

/**
 * generated from [DeleteRuleQuery](../../data/contracts/rules.ck)
 */
export const DeleteRuleQuery = z.strictObject({
    message: z.string().optional(),
});
export type DeleteRuleQuery = z.infer<typeof DeleteRuleQuery>;

/**
 * One change to a rule. No `snapshot` means the rule was removed.
 * generated from [RuleRevision](../../data/contracts/rules.ck)
 */
export const RuleRevision = z.strictObject({
    id: z.string(),
    rule: z.string(),
    snapshot: _ZodJson.optional(),
    message: z.string(),
    createdAt: _ZodDatetime,
});
export type RuleRevision = z.infer<typeof RuleRevision>;

/**
 * generated from [RuleRevisionsQuery](../../data/contracts/rules.ck)
 */
export const RuleRevisionsQuery = z.strictObject({
    rule: z.string().optional(),
    limit: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
});
export type RuleRevisionsQuery = z.infer<typeof RuleRevisionsQuery>;

/**
 * What to check: `branch`'s diff from its merge base with `base`, which is what the project's code root
 * has checked out when left out.
 * generated from [RuleCheckRequest](../../data/contracts/rules.ck)
 */
export const RuleCheckRequest = z.strictObject({
    branch: z.string(),
    base: z.string().optional(),
});
export type RuleCheckRequest = z.infer<typeof RuleCheckRequest>;

/**
 * generated from [RuleCheckVerdict](../../data/contracts/rules.ck)
 */
export const RuleCheckVerdict = z.strictObject({
    rule: z.string(),
    revision: z.string(),
    statement: z.string(),
    severity: z.enum(['blocker', 'concern']),
    paths: z.array(z.string()),
    verdict: z.enum(['pass', 'fail', 'unavailable']),
    file: z.string().optional(),
    line: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    evidence: z.string(),
    reused: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()),
});
export type RuleCheckVerdict = z.infer<typeof RuleCheckVerdict>;

/**
 * generated from [RuleCheckUsage](../../data/contracts/rules.ck)
 */
export const RuleCheckUsage = z.strictObject({
    inputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    cachedInputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    cacheWriteInputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
    outputTokens: z.preprocess(v => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v), z.number().int()).optional(),
});
export type RuleCheckUsage = z.infer<typeof RuleCheckUsage>;

/**
 * A rule a model drafted from a blocker that survived challenge and sent a card back. It is nothing until
 * a person accepts it, and stops being offered after 45 days.
 * generated from [RuleProposal](../../data/contracts/rules.ck)
 */
export const RuleProposal = z.strictObject({
    id: z.string(),
    cardId: z.string(),
    statement: z.string(),
    paths: z.array(z.string()),
    reason: z.string(),
    expiresAt: _ZodDatetime,
    createdAt: _ZodDatetime,
});
export type RuleProposal = z.infer<typeof RuleProposal>;

/**
 * What the rule is called, which a person chooses, and any words they changed.
 * generated from [AcceptRuleProposalRequest](../../data/contracts/rules.ck)
 */
export const AcceptRuleProposalRequest = z.strictObject({
    id: z.string(),
    statement: z.string().optional(),
    paths: z.array(z.string()).optional(),
    severity: z.enum(['blocker', 'concern']).optional(),
});
export type AcceptRuleProposalRequest = z.infer<typeof AcceptRuleProposalRequest>;

/**
 * generated from [RuleCheckReport](../../data/contracts/rules.ck)
 */
export const RuleCheckReport = z.strictObject({
    branch: z.string(),
    mergeBase: z.string(),
    verdicts: z.array(RuleCheckVerdict),
    usage: RuleCheckUsage.optional(),
});
export type RuleCheckReport = z.infer<typeof RuleCheckReport>;
