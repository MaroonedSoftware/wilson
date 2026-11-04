import { Injectable } from 'injectkit';
import { Kysely, sql, type Selectable } from 'kysely';
import { DateTime } from 'luxon';
import { BoardConfig } from '#modules/board/board.config.js';
import type { DB, WilsonRuleVerdicts } from '#modules/data/db.js';

export type RuleVerdictValue = 'pass' | 'fail' | 'unavailable';

/** A verdict as it is written down. */
export interface RuleVerdictRecord {
    rule: string;
    /** The `wilson.rule_revisions` id of the rule's words this judged. */
    revision: string;
    diffHash: string;
    cardId?: string;
    verdict: RuleVerdictValue;
    file?: string;
    line?: number;
    evidence: string;
    engine?: string;
    model?: string;
    usage?: unknown;
}

const toRecord = (row: Selectable<WilsonRuleVerdicts>): RuleVerdictRecord => ({
    rule: row.rule,
    revision: String(row.ruleRevisionId),
    diffHash: row.diffHash,
    ...(row.cardId == null ? {} : { cardId: row.cardId }),
    verdict: row.verdict as RuleVerdictValue,
    ...(row.file == null ? {} : { file: row.file }),
    ...(row.line == null ? {} : { line: row.line }),
    evidence: row.evidence,
    ...(row.engine == null ? {} : { engine: row.engine }),
    ...(row.model == null ? {} : { model: row.model }),
    ...(row.usage == null ? {} : { usage: row.usage }),
});

/** `wilson.rule_verdicts`, which is what makes asking twice about the same words and the same code free. */
@Injectable()
export class RuleVerdictStore {
    constructor(
        private readonly config: BoardConfig,
        private readonly db: Kysely<DB>,
    ) {}

    /** The answer already given for this revision and diff. A failure to answer is not one. */
    async answered(revision: string, diffHash: string): Promise<RuleVerdictRecord | undefined> {
        const row = await this.db
            .selectFrom('wilson.ruleVerdicts')
            .selectAll()
            .where('project', '=', this.config.project)
            .where('ruleRevisionId', '=', BigInt(revision))
            .where('diffHash', '=', diffHash)
            .where('verdict', 'in', ['pass', 'fail'])
            .executeTakeFirst();
        return row && toRecord(row);
    }

    /**
     * Write a verdict, and answer with what the row now says. An answer replaces an 'unavailable' but
     * nothing replaces an answer: two runs racing the same key keep the first, so a card cannot be told
     * two things about one diff.
     */
    async record(verdict: RuleVerdictRecord): Promise<RuleVerdictRecord> {
        const project = this.config.project;
        const ruleRevisionId = BigInt(verdict.revision);
        const values = {
            cardId: verdict.cardId ?? null,
            verdict: verdict.verdict,
            file: verdict.file ?? null,
            line: verdict.line ?? null,
            evidence: verdict.evidence,
            engine: verdict.engine ?? null,
            model: verdict.model ?? null,
            usage: verdict.usage === undefined ? null : JSON.stringify(verdict.usage),
        };
        const written = await this.db
            .insertInto('wilson.ruleVerdicts')
            .values({ project, rule: verdict.rule, ruleRevisionId, diffHash: verdict.diffHash, ...values })
            .onConflict(oc =>
                oc
                    .columns(['project', 'ruleRevisionId', 'diffHash'])
                    .doUpdateSet({ ...values, updatedAt: DateTime.now() })
                    .where(sql`wilson.rule_verdicts.verdict`, '=', 'unavailable'),
            )
            .returningAll()
            .executeTakeFirst();
        if (written) return toRecord(written);

        const existing = await this.db
            .selectFrom('wilson.ruleVerdicts')
            .selectAll()
            .where('project', '=', project)
            .where('ruleRevisionId', '=', ruleRevisionId)
            .where('diffHash', '=', verdict.diffHash)
            .executeTakeFirstOrThrow();
        return toRecord(existing);
    }
}
