import { Injectable } from 'injectkit';
// A value import, not `import type`: `@Injectable()`'s `design:paramtypes` metadata has to name
// `Kysely` as a value, the reason `ProjectRepository` gives for the same line.
import { Kysely, sql } from 'kysely';
import type { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';
import type { EngineTokenKind, EngineTokenProvider } from '../../generated/engine.tokens.js';

/** What a saved token signs in to, and where it comes among its provider's tokens. */
export interface EngineTokenAccount {
    provider: EngineTokenProvider;
    kind: EngineTokenKind;
    priority: number;
    pooled: boolean;
}

/** A saved token as it may be shown: `ciphertext` stays behind {@link EngineTokenRepository.ciphertext}. */
export interface EngineTokenRow extends EngineTokenAccount {
    name: string;
    createdAt: DateTime;
    updatedAt: DateTime;
    /** The worker hosts assigned it, name ascending. */
    hosts: string[];
}

/** `wilson.engine_tokens`, in Postgres. Sees only ciphertext; `EngineTokensService` holds the key. */
@Injectable()
export class EngineTokenRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /** Every saved token, name ascending. */
    async list(): Promise<EngineTokenRow[]> {
        const tokens = await this.db
            .selectFrom('wilson.engineTokens')
            .select(['name', 'provider', 'kind', 'priority', 'pooled', 'createdAt', 'updatedAt'])
            .orderBy('name')
            .execute();
        const hosts = await this.db
            .selectFrom('wilson.hosts')
            .select(['name', 'engineToken'])
            .where('engineToken', 'is not', null)
            .orderBy('name')
            .execute();
        return tokens.map(token => ({ ...token, hosts: hosts.filter(host => host.engineToken === token.name).map(host => host.name) }));
    }

    /**
     * Save `ciphertext` under `name`, replacing any saved there, and leaving every other row alone.
     * What `account` leaves out keeps its value on a saved row, and takes the column's default on a new one.
     */
    async put(name: string, ciphertext: string, account: Partial<EngineTokenAccount> = {}): Promise<void> {
        await this.db
            .insertInto('wilson.engineTokens')
            .values({ name, ciphertext, ...account })
            .onConflict(oc => oc.column('name').doUpdateSet({ ciphertext, ...account, updatedAt: sql`now()` }))
            .execute();
    }

    /** Change what is recorded about `name`, keeping its token. Returns whether a row matched. */
    async update(name: string, account: Partial<EngineTokenAccount>): Promise<boolean> {
        const result = await this.db
            .updateTable('wilson.engineTokens')
            .set({ ...account, updatedAt: sql`now()` })
            .where('name', '=', name)
            .executeTakeFirst();
        return result.numUpdatedRows > 0n;
    }

    /**
     * Hold the token saved as `from` under `to` instead, keeping its token, account and both timestamps:
     * a rename is not a re-save, so `updatedAt` is left alone. Returns whether a row matched.
     *
     * There is no `wilson.hosts` statement here: a host assigned the token follows it by the foreign
     * key's `ON UPDATE CASCADE`. One statement, but a transaction all the same, because moving the
     * `wilson.engine_limits` rows standing against `from` belongs in this one when it lands, not a second.
     */
    async rename(from: string, to: string): Promise<boolean> {
        return this.db.transaction().execute(async trx => {
            const result = await trx.updateTable('wilson.engineTokens').set({ name: to }).where('name', '=', from).executeTakeFirst();
            if (result.numUpdatedRows === 0n) return false;
            return true;
        });
    }

    /** The stored ciphertext for `name`, or undefined when none is saved. */
    async ciphertext(name: string): Promise<string | undefined> {
        const row = await this.db.selectFrom('wilson.engineTokens').select('ciphertext').where('name', '=', name).executeTakeFirst();
        return row?.ciphertext;
    }

    /** Forget `name`. Returns whether a row matched. */
    async remove(name: string): Promise<boolean> {
        const result = await this.db.deleteFrom('wilson.engineTokens').where('name', '=', name).executeTakeFirst();
        return result.numDeletedRows > 0n;
    }
}
