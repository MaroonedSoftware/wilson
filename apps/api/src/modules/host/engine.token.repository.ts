import { Injectable } from 'injectkit';
// A value import, not `import type`: `@Injectable()`'s `design:paramtypes` metadata has to name
// `Kysely` as a value, the reason `ProjectRepository` gives for the same line.
import { Kysely, sql } from 'kysely';
import type { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';

/** A saved token as it may be shown: `ciphertext` stays behind {@link EngineTokenRepository.ciphertext}. */
export interface EngineTokenRow {
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
        const tokens = await this.db.selectFrom('wilson.engineTokens').select(['name', 'createdAt', 'updatedAt']).orderBy('name').execute();
        const hosts = await this.db
            .selectFrom('wilson.hosts')
            .select(['name', 'engineToken'])
            .where('engineToken', 'is not', null)
            .orderBy('name')
            .execute();
        return tokens.map(token => ({ ...token, hosts: hosts.filter(host => host.engineToken === token.name).map(host => host.name) }));
    }

    /** Save `ciphertext` under `name`, replacing any saved there, and leaving every other row alone. */
    async put(name: string, ciphertext: string): Promise<void> {
        await this.db
            .insertInto('wilson.engineTokens')
            .values({ name, ciphertext })
            .onConflict(oc => oc.column('name').doUpdateSet({ ciphertext, updatedAt: sql`now()` }))
            .execute();
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
