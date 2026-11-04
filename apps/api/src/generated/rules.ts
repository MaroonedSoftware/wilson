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
