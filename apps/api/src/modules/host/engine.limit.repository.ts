import { Injectable } from 'injectkit';
// A value import, not `import type`: `@Injectable()`'s `design:paramtypes` metadata has to name
// `Kysely` as a value, the reason `ProjectRepository` gives for the same line.
import { Kysely, sql } from 'kysely';
import { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';

/** A limit an account has hit that has not reset yet. */
export interface EngineLimitRow {
    account: string;
    limitType: string;
    resetsAt: DateTime;
}

/** `wilson.engine_limits`, in Postgres. */
@Injectable()
export class EngineLimitRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /** Record that `account` hit `limitType`, replacing what an earlier hit of the same limit said. */
    async record(account: string, limitType: string, resetsAt: DateTime): Promise<void> {
        await this.db
            .insertInto('wilson.engineLimits')
            .values({ account, limitType, resetsAt })
            .onConflict(oc => oc.columns(['account', 'limitType']).doUpdateSet({ resetsAt, recordedAt: sql`now()` }))
            .execute();
    }

    /** Every limit still in force, soonest reset first. */
    async active(now: DateTime = DateTime.now()): Promise<EngineLimitRow[]> {
        return this.db
            .selectFrom('wilson.engineLimits')
            .select(['account', 'limitType', 'resetsAt'])
            .where('resetsAt', '>', now)
            .orderBy('resetsAt')
            .execute();
    }

    /** Forget what is recorded against `account`, whose token has been replaced or removed. */
    async clear(account: string): Promise<void> {
        await this.db.deleteFrom('wilson.engineLimits').where('account', '=', account).execute();
    }
}
