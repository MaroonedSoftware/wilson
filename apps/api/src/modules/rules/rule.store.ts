import { Injectable } from 'injectkit';
import { Kysely, type Selectable, type Transaction } from 'kysely';
import { DateTime } from 'luxon';
import picomatch from 'picomatch';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB, WilsonRules } from '#modules/data/db.js';

export const RULE_SEVERITIES = ['blocker', 'concern'] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];

export const MAX_RULE_STATEMENT_LENGTH = 2000;
const MAX_RULE_PATHS = 50;
const RULE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** What a person says about a rule. */
export interface RuleFields {
    statement: string;
    paths: string[];
    severity: RuleSeverity;
}

export interface Rule extends RuleFields {
    id: string;
    /** The newest `wilson.rule_revisions` id, which a verdict is keyed on. */
    revision: string;
    createdAt: DateTime;
    updatedAt: DateTime;
}

export interface RuleRevision {
    id: string;
    rule: string;
    /** Absent when the rule was removed. */
    snapshot?: unknown;
    message: string;
    createdAt: DateTime;
}

/** Why a rule could not be saved. `reason` is what the person reads. */
export class RuleRefusedError extends Error {
    constructor(
        readonly kind: 'invalid' | 'duplicate' | 'not-found',
        reason: string,
    ) {
        super(reason);
        this.name = 'RuleRefusedError';
    }
}

/** Whether `path` is one a rule with these globs is about. The same matching scope overlap uses. */
export const ruleMatcher = (paths: readonly string[]): ((path: string) => boolean) => picomatch([...paths], { dot: true });

/** Trim what a person typed and refuse what could never work, naming the reason. */
export const validateRuleFields = ({ statement, paths, severity }: RuleFields): RuleFields => {
    const trimmed = statement.trim();
    if (trimmed.length === 0) throw new RuleRefusedError('invalid', 'a rule needs a statement');
    if (trimmed.length > MAX_RULE_STATEMENT_LENGTH) {
        throw new RuleRefusedError('invalid', `a rule's statement can be at most ${MAX_RULE_STATEMENT_LENGTH} characters`);
    }
    if (!RULE_SEVERITIES.includes(severity)) throw new RuleRefusedError('invalid', `severity must be one of ${RULE_SEVERITIES.join(', ')}`);

    const globs = paths.map(path => path.trim());
    if (globs.length === 0) throw new RuleRefusedError('invalid', 'a rule needs at least one path glob; use "**" for every file');
    if (globs.length > MAX_RULE_PATHS) throw new RuleRefusedError('invalid', `a rule can have at most ${MAX_RULE_PATHS} path globs`);
    for (const glob of globs) {
        if (glob.length === 0) throw new RuleRefusedError('invalid', 'a path glob cannot be empty');
        // Changed paths are relative to the repo and never start with these, so such a glob would
        // silently match nothing and the rule would never run.
        if (glob.startsWith('/') || glob.startsWith('./')) throw new RuleRefusedError('invalid', `"${glob}" must be relative to the repo root`);
        try {
            picomatch.makeRe(glob, { dot: true });
        } catch (err) {
            throw new RuleRefusedError('invalid', `"${glob}" is not a valid glob: ${(err as Error).message}`);
        }
    }
    return { statement: trimmed, paths: globs, severity };
};

/**
 * A project's checked rules.
 *
 * Abstract for the reason `StageConfigStore` is: production wires Postgres through DI, and a test that
 * only needs "some rules" constructs {@link StaticRuleStore}.
 */
@Injectable()
export abstract class RuleStore {
    /** The current project's rules, by id. Empty when it has none. */
    abstract list(): Promise<Rule[]>;
    abstract get(id: string): Promise<Rule | undefined>;
    /** Refused with {@link RuleRefusedError} for a malformed rule or an id already taken. */
    abstract create(id: string, fields: RuleFields, message: string): Promise<Rule>;
    /** Refused with {@link RuleRefusedError} for no such rule or a malformed result. A change to nothing records no revision. */
    abstract update(id: string, patch: Partial<RuleFields>, message: string): Promise<Rule>;
    /** Refused with {@link RuleRefusedError} for no such rule. */
    abstract remove(id: string, message: string): Promise<void>;
    /** The current project's rule changes, newest first, for one rule when `rule` names it. */
    abstract revisions(rule: string | undefined, limit: number): Promise<RuleRevision[]>;
}

const toRule = (row: Selectable<WilsonRules>): Rule => ({
    id: row.id,
    statement: row.statement,
    paths: row.paths,
    severity: row.severity as RuleSeverity,
    revision: String(row.revisionId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const sameFields = (a: RuleFields, b: RuleFields): boolean =>
    a.statement === b.statement && a.severity === b.severity && a.paths.length === b.paths.length && a.paths.every((path, i) => path === b.paths[i]);

/**
 * `wilson.rules` and `wilson.rule_revisions`. Keyed by `BoardConfig.project` and read fresh on every
 * call, as `PostgresStageConfigStore` is, so the same instance answers for whichever project's work is
 * on the call stack.
 */
@Injectable()
export class PostgresRuleStore extends RuleStore {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {
        super();
    }

    async list(): Promise<Rule[]> {
        const rows = await this.db.selectFrom('wilson.rules').selectAll().where('project', '=', this.config.project).orderBy('id').execute();
        return rows.map(toRule);
    }

    async get(id: string): Promise<Rule | undefined> {
        const row = await this.db
            .selectFrom('wilson.rules')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('id', '=', id)
            .executeTakeFirst();
        return row && toRule(row);
    }

    async create(id: string, fields: RuleFields, message: string): Promise<Rule> {
        if (!RULE_ID.test(id)) {
            throw new RuleRefusedError('invalid', `"${id}" is not a rule id: use lower-case letters, digits and hyphens, at most 64 characters`);
        }
        const valid = validateRuleFields(fields);
        const project = this.config.project;
        return this.db.transaction().execute(async trx => {
            // Taken before the revision, so a refused id leaves no history behind.
            const inserted = await trx
                .insertInto('wilson.rules')
                .values({ project, id, ...valid, revisionId: 0n })
                .onConflict(oc => oc.columns(['project', 'id']).doNothing())
                .returning('id')
                .executeTakeFirst();
            if (!inserted) throw new RuleRefusedError('duplicate', `there is already a rule "${id}"`);
            return this.recordRevision(trx, id, valid, message);
        });
    }

    async update(id: string, patch: Partial<RuleFields>, message: string): Promise<Rule> {
        const project = this.config.project;
        return this.db.transaction().execute(async trx => {
            const row = await trx
                .selectFrom('wilson.rules')
                .selectAll()
                .where('project', '=', project)
                .where('id', '=', id)
                .forUpdate()
                .executeTakeFirst();
            if (!row) throw new RuleRefusedError('not-found', `there is no rule "${id}"`);

            const current = toRule(row);
            const next = validateRuleFields({
                statement: patch.statement ?? current.statement,
                paths: patch.paths ?? current.paths,
                severity: patch.severity ?? current.severity,
            });
            if (sameFields(current, next)) return current;
            return this.recordRevision(trx, id, next, message);
        });
    }

    async remove(id: string, message: string): Promise<void> {
        const project = this.config.project;
        await this.db.transaction().execute(async trx => {
            const removed = await trx
                .deleteFrom('wilson.rules')
                .where('project', '=', project)
                .where('id', '=', id)
                .returning('id')
                .executeTakeFirst();
            if (!removed) throw new RuleRefusedError('not-found', `there is no rule "${id}"`);
            await trx.insertInto('wilson.ruleRevisions').values({ project, rule: id, snapshot: null, message }).execute();
        });
    }

    async revisions(rule: string | undefined, limit: number): Promise<RuleRevision[]> {
        let query = this.db.selectFrom('wilson.ruleRevisions').selectAll().where('project', '=', this.config.project);
        if (rule !== undefined) query = query.where('rule', '=', rule);
        const rows = await query.orderBy('id', 'desc').limit(limit).execute();
        return rows.map(row => ({
            id: String(row.id),
            rule: row.rule,
            ...(row.snapshot == null ? {} : { snapshot: row.snapshot }),
            message: row.message,
            createdAt: row.createdAt,
        }));
    }

    /** Add the revision and point the rule at it, so a rule's `revision` always names what it says. */
    private async recordRevision(trx: Transaction<DB>, id: string, fields: RuleFields, message: string): Promise<Rule> {
        const project = this.config.project;
        const revision = await trx
            .insertInto('wilson.ruleRevisions')
            .values({ project, rule: id, snapshot: JSON.stringify(fields), message })
            .returning('id')
            .executeTakeFirstOrThrow();
        const row = await trx
            .updateTable('wilson.rules')
            .set({ ...fields, revisionId: BigInt(revision.id), updatedAt: DateTime.now() })
            .where('project', '=', project)
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
        return toRule(row);
    }
}

/** An in-memory store, for tests: the counterpart of `StaticStageConfigStore`. */
export class StaticRuleStore extends RuleStore {
    private readonly rules = new Map<string, Rule>();
    private readonly history: RuleRevision[] = [];
    private next = 1;

    async list(): Promise<Rule[]> {
        return [...this.rules.values()].sort((a, b) => a.id.localeCompare(b.id));
    }

    async get(id: string): Promise<Rule | undefined> {
        return this.rules.get(id);
    }

    async create(id: string, fields: RuleFields, message: string): Promise<Rule> {
        if (!RULE_ID.test(id)) throw new RuleRefusedError('invalid', `"${id}" is not a rule id`);
        if (this.rules.has(id)) throw new RuleRefusedError('duplicate', `there is already a rule "${id}"`);
        return this.write(id, validateRuleFields(fields), message);
    }

    async update(id: string, patch: Partial<RuleFields>, message: string): Promise<Rule> {
        const current = this.rules.get(id);
        if (!current) throw new RuleRefusedError('not-found', `there is no rule "${id}"`);
        const next = validateRuleFields({ ...current, ...patch });
        return sameFields(current, next) ? current : this.write(id, next, message);
    }

    async remove(id: string, message: string): Promise<void> {
        if (!this.rules.delete(id)) throw new RuleRefusedError('not-found', `there is no rule "${id}"`);
        this.history.unshift({ id: String(this.next++), rule: id, message, createdAt: DateTime.now() });
    }

    async revisions(rule: string | undefined, limit: number): Promise<RuleRevision[]> {
        return this.history.filter(entry => rule === undefined || entry.rule === rule).slice(0, limit);
    }

    private write(id: string, fields: RuleFields, message: string): Rule {
        const revision = String(this.next++);
        const now = DateTime.now();
        const rule: Rule = { id, ...fields, revision, createdAt: this.rules.get(id)?.createdAt ?? now, updatedAt: now };
        this.rules.set(id, rule);
        this.history.unshift({ id: revision, rule: id, snapshot: fields, message, createdAt: now });
        return rule;
    }
}
