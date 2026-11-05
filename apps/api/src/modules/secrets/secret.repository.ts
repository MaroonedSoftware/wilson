import { Injectable } from 'injectkit';
// A value import, not `import type`: `@Injectable()`'s `design:paramtypes` metadata has to name
// `Kysely` as a value, the reason `ProjectRepository` gives for the same line.
import { Kysely, sql } from 'kysely';
import type { DateTime } from 'luxon';
import type { DB } from '#modules/data/db.js';

/** A saved secret as it may be shown: `ciphertext` stays behind {@link SecretRepository.ciphertext}. */
export interface SecretRow {
    name: string;
    createdAt: DateTime;
    updatedAt: DateTime;
    /** The MCP connections using it, name ascending. */
    connections: string[];
}

/** `wilson.secrets`, in Postgres. Sees only ciphertext; `SecretsService` holds the key. */
@Injectable()
export class SecretRepository {
    constructor(private readonly db: Kysely<DB>) {}

    /** Every saved secret, name ascending. */
    async list(): Promise<SecretRow[]> {
        const secrets = await this.db.selectFrom('wilson.secrets').select(['name', 'createdAt', 'updatedAt']).orderBy('name').execute();
        const connections = await this.db
            .selectFrom('wilson.mcpConnections')
            .select(['name', 'secret'])
            .where('secret', 'is not', null)
            .orderBy('name')
            .execute();
        return secrets.map(secret => ({
            ...secret,
            connections: connections.filter(connection => connection.secret === secret.name).map(connection => connection.name),
        }));
    }

    /** Save `ciphertext` under `name`, replacing any saved there. */
    async put(name: string, ciphertext: string): Promise<void> {
        await this.db
            .insertInto('wilson.secrets')
            .values({ name, ciphertext })
            .onConflict(oc => oc.column('name').doUpdateSet({ ciphertext, updatedAt: sql`now()` }))
            .execute();
    }

    /** The stored ciphertext for `name`, or undefined when none is saved. */
    async ciphertext(name: string): Promise<string | undefined> {
        const row = await this.db.selectFrom('wilson.secrets').select('ciphertext').where('name', '=', name).executeTakeFirst();
        return row?.ciphertext;
    }

    /** Every saved secret's ciphertext, whatever its name. */
    async allCiphertext(): Promise<string[]> {
        return (await this.db.selectFrom('wilson.secrets').select('ciphertext').execute()).map(row => row.ciphertext);
    }

    /** Forget `name`. Returns whether a row matched. */
    async remove(name: string): Promise<boolean> {
        const result = await this.db.deleteFrom('wilson.secrets').where('name', '=', name).executeTakeFirst();
        return result.numDeletedRows > 0n;
    }
}
