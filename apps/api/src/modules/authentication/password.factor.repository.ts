import { Injectable } from 'injectkit';
import { Kysely, type Selectable } from 'kysely';
import { PasswordFactorRepository, type PasswordFactor, type PasswordValue } from '@maroonedsoftware/authentication';
import type { AccountPasswords, DB } from '#modules/data/db.js';

const toFactor = (row: Selectable<AccountPasswords>): PasswordFactor => ({
    id: row.accountId,
    actorId: row.accountId,
    hash: row.hash,
    salt: row.salt,
    value: { hash: row.hash, salt: row.salt },
    active: row.active,
    needsReset: row.needsReset,
});

/**
 * `runner.account_passwords` behind `@maroonedsoftware/authentication`'s `PasswordFactorRepository`,
 * after deadair's. A password is one row per account and keyed by it, so the factor id is the
 * account id, and the library's `getFactor(actorId, actorId)` reads the same row both ways.
 */
@Injectable()
export class AccountPasswordRepository extends PasswordFactorRepository {
    constructor(private readonly db: Kysely<DB>) {
        super();
    }

    async createFactor(actorId: string, value: PasswordValue): Promise<PasswordFactor> {
        const row = await this.db
            .insertInto('runner.accountPasswords')
            .values({ accountId: actorId, hash: value.hash, salt: value.salt, needsReset: value.needsReset ?? false })
            .returningAll()
            .executeTakeFirstOrThrow();
        return toFactor(row);
    }

    /**
     * The library declares `Promise<PasswordFactor>`, but every caller checks for a missing factor,
     * so a missing row resolves to `undefined` as deadair's does.
     */
    async getFactor(actorId: string, _factorId: string): Promise<PasswordFactor> {
        const row = await this.db.selectFrom('runner.accountPasswords').selectAll().where('accountId', '=', actorId).executeTakeFirst();
        return (row ? toFactor(row) : undefined) as PasswordFactor;
    }

    async listFactors(actorId: string, active?: boolean): Promise<PasswordFactor[]> {
        let query = this.db.selectFrom('runner.accountPasswords').selectAll().where('accountId', '=', actorId);
        if (active !== undefined) query = query.where('active', '=', active);
        return (await query.execute()).map(toFactor);
    }

    /** Passwords are never looked up by value; the interface requires the method. */
    async lookupFactor(_actorId: string, _value: string): Promise<PasswordFactor | undefined> {
        return undefined;
    }

    /**
     * Empty: there is no password history yet, because there is no password change yet. When one is
     * built, it needs an archive table here so the library can refuse a reused password.
     */
    async listPreviousPasswords(_actorId: string, _limit: number): Promise<PasswordValue[]> {
        return [];
    }

    async updateFactor(actorId: string, value: PasswordValue): Promise<PasswordFactor> {
        const row = await this.db
            .updateTable('runner.accountPasswords')
            .set({ hash: value.hash, salt: value.salt, needsReset: value.needsReset ?? false, updatedAt: new Date().toISOString() })
            .where('accountId', '=', actorId)
            .returningAll()
            .executeTakeFirstOrThrow();
        return toFactor(row);
    }

    async deleteFactor(actorId: string, _factorId?: string): Promise<void> {
        await this.db.updateTable('runner.accountPasswords').set({ active: false }).where('accountId', '=', actorId).execute();
    }
}
