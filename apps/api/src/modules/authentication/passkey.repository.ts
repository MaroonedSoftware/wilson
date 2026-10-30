import { Injectable } from 'injectkit';
import { Kysely, type Selectable } from 'kysely';
import { FidoFactorRepository, type FidoFactor, type FidoFactorOptions } from '@maroonedsoftware/authentication';
import { httpError } from '@maroonedsoftware/errors';
import type { WilsonAccountPasskeys, DB } from '#modules/data/db.js';

const toFactor = (row: Selectable<WilsonAccountPasskeys>): FidoFactor => ({
    id: row.id,
    actorId: row.accountId,
    active: row.active,
    publicKey: row.publicKey,
    publicKeyId: row.publicKeyId,
    counter: Number(row.counter),
    ...(row.label === null ? {} : { label: row.label }),
});

/** `wilson.account_passkeys` behind the library's `FidoFactorRepository`, after deadair's. */
@Injectable()
export class AccountPasskeyRepository extends FidoFactorRepository {
    constructor(private readonly db: Kysely<DB>) {
        super();
    }

    async createFactor(actorId: string, options: FidoFactorOptions): Promise<FidoFactor> {
        const row = await this.db
            .insertInto('wilson.accountPasskeys')
            .values({
                accountId: actorId,
                publicKey: options.publicKey,
                publicKeyId: options.publicKeyId,
                counter: options.counter,
                label: options.label ?? null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        return toFactor(row);
    }

    async listFactors(actorId: string, active?: boolean): Promise<FidoFactor[]> {
        let query = this.db.selectFrom('wilson.accountPasskeys').selectAll().where('accountId', '=', actorId);
        if (active !== undefined) query = query.where('active', '=', active);
        return (await query.orderBy('createdAt').execute()).map(toFactor);
    }

    /** By credential id, which is what a browser presents. */
    async lookupFactor(actorId: string, credentialId: string): Promise<FidoFactor | undefined> {
        const row = await this.db
            .selectFrom('wilson.accountPasskeys')
            .selectAll()
            .where('accountId', '=', actorId)
            .where('publicKeyId', '=', credentialId)
            .where('active', '=', true)
            .executeTakeFirst();
        return row ? toFactor(row) : undefined;
    }

    async getFactor(actorId: string, factorId: string): Promise<FidoFactor> {
        const row = await this.db
            .selectFrom('wilson.accountPasskeys')
            .selectAll()
            .where('accountId', '=', actorId)
            .where('id', '=', factorId)
            .executeTakeFirst();
        if (!row) throw httpError(404).withDetails({ reason: `no passkey ${factorId}` });
        return toFactor(row);
    }

    async updateFactorCounter(actorId: string, factorId: string, counter: number): Promise<void> {
        await this.db.updateTable('wilson.accountPasskeys').set({ counter }).where('accountId', '=', actorId).where('id', '=', factorId).execute();
    }

    async deleteFactor(actorId: string, factorId: string): Promise<void> {
        await this.db
            .updateTable('wilson.accountPasskeys')
            .set({ active: false })
            .where('accountId', '=', actorId)
            .where('id', '=', factorId)
            .execute();
    }
}
