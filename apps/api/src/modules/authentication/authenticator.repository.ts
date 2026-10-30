import { Injectable } from 'injectkit';
import { Kysely, type Selectable } from 'kysely';
import { AuthenticatorFactorRepository, type AuthenticatorFactor, type AuthenticatorFactorOptions } from '@maroonedsoftware/authentication';
import { httpError } from '@maroonedsoftware/errors';
import type { WilsonAccountAuthenticators, DB } from '#modules/data/db.js';

const toFactor = (row: Selectable<WilsonAccountAuthenticators>): AuthenticatorFactor => ({
    id: row.id,
    actorId: row.accountId,
    active: row.active,
    secretHash: row.secret,
    type: row.type as AuthenticatorFactor['type'],
    algorithm: row.algorithm as AuthenticatorFactor['algorithm'],
    tokenLength: row.tokenLength,
    periodSeconds: row.periodSeconds,
    counter: row.counter,
    ...(row.label === null ? {} : { label: row.label }),
});

/**
 * `wilson.account_authenticators` behind the library's `AuthenticatorFactorRepository`, after
 * deadair's. `secretHash` is the library's name for the seed it encrypted before handing it here.
 */
@Injectable()
export class AccountAuthenticatorRepository extends AuthenticatorFactorRepository {
    constructor(private readonly db: Kysely<DB>) {
        super();
    }

    async createFactor(actorId: string, options: AuthenticatorFactorOptions): Promise<AuthenticatorFactor> {
        const row = await this.db
            .insertInto('wilson.accountAuthenticators')
            .values({
                accountId: actorId,
                secret: options.secretHash,
                type: options.type,
                algorithm: options.algorithm,
                tokenLength: options.tokenLength,
                periodSeconds: options.periodSeconds ?? 30,
                counter: options.counter ?? 0,
                label: options.label ?? null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        return toFactor(row);
    }

    async listFactors(actorId: string, active?: boolean): Promise<AuthenticatorFactor[]> {
        let query = this.db.selectFrom('wilson.accountAuthenticators').selectAll().where('accountId', '=', actorId);
        if (active !== undefined) query = query.where('active', '=', active);
        return (await query.orderBy('createdAt').execute()).map(toFactor);
    }

    async lookupFactor(actorId: string, label: string): Promise<AuthenticatorFactor | undefined> {
        const row = await this.db
            .selectFrom('wilson.accountAuthenticators')
            .selectAll()
            .where('accountId', '=', actorId)
            .where('label', '=', label)
            .where('active', '=', true)
            .executeTakeFirst();
        return row ? toFactor(row) : undefined;
    }

    async getFactor(actorId: string, factorId: string): Promise<AuthenticatorFactor> {
        const row = await this.db
            .selectFrom('wilson.accountAuthenticators')
            .selectAll()
            .where('accountId', '=', actorId)
            .where('id', '=', factorId)
            .executeTakeFirst();
        if (!row) throw httpError(404).withDetails({ reason: `no authenticator ${factorId}` });
        return toFactor(row);
    }

    /** Advance the replay guard past the step that just validated, so the same code works once. */
    async updateFactorCounter(actorId: string, factorId: string, counter: number): Promise<void> {
        await this.db
            .updateTable('wilson.accountAuthenticators')
            .set({ counter })
            .where('accountId', '=', actorId)
            .where('id', '=', factorId)
            .execute();
    }

    async deleteFactor(actorId: string, factorId: string): Promise<void> {
        await this.db
            .updateTable('wilson.accountAuthenticators')
            .set({ active: false })
            .where('accountId', '=', actorId)
            .where('id', '=', factorId)
            .execute();
    }
}
