import { Injectable } from 'injectkit';
import { Kysely, sql, type Selectable } from 'kysely';
import type { DateTime } from 'luxon';
import { ApiKeyRepository, type ApiKey, type ApiKeyListOptions, type ApiKeyUpdatePatch, type TargetActor } from '@maroonedsoftware/authentication';
import type { WilsonApiKeys, DB } from '#modules/data/db.js';

/** The one kind of principal that owns a key: the operator account. */
export const ACCOUNT_ACTOR = 'account';
export type AccountActor = typeof ACCOUNT_ACTOR;

const toKey = (row: Selectable<WilsonApiKeys>): ApiKey<AccountActor> => ({
    id: row.id,
    owner: { kind: ACCOUNT_ACTOR, actorId: row.accountId },
    name: row.name,
    ...(row.type === null ? {} : { type: row.type }),
    hint: row.hint,
    secretHash: row.secretHash,
    scopes: row.scopes,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt,
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
});

/** `wilson.api_keys` behind the library's `ApiKeyRepository`. */
@Injectable()
export class AccountApiKeyRepository extends ApiKeyRepository<AccountActor> {
    constructor(private readonly db: Kysely<DB>) {
        super();
    }

    async create(key: ApiKey<AccountActor>): Promise<ApiKey<AccountActor>> {
        const row = await this.db
            .insertInto('wilson.apiKeys')
            .values({
                id: key.id,
                accountId: key.owner.actorId,
                name: key.name,
                type: key.type ?? null,
                hint: key.hint,
                secretHash: key.secretHash,
                scopes: key.scopes,
                metadata: JSON.stringify(key.metadata ?? {}),
                createdAt: key.createdAt,
                expiresAt: key.expiresAt ? key.expiresAt : null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        return toKey(row);
    }

    async findById(id: string): Promise<ApiKey<AccountActor> | undefined> {
        const row = await this.db.selectFrom('wilson.apiKeys').selectAll().where('id', '=', id).executeTakeFirst();
        return row ? toKey(row) : undefined;
    }

    async findBySecretHash(secretHash: string): Promise<ApiKey<AccountActor> | undefined> {
        const row = await this.db.selectFrom('wilson.apiKeys').selectAll().where('secretHash', '=', secretHash).executeTakeFirst();
        return row ? toKey(row) : undefined;
    }

    async listByOwner(owner: TargetActor<AccountActor>, options?: ApiKeyListOptions): Promise<ApiKey<AccountActor>[]> {
        let query = this.db.selectFrom('wilson.apiKeys').selectAll().where('accountId', '=', owner.actorId);
        if (!options?.includeInactive) {
            query = query
                .where('revokedAt', 'is', null)
                .where(eb => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', sql<DateTime>`now()`)]));
        }
        return (await query.orderBy('createdAt', 'desc').execute()).map(toKey);
    }

    async update(id: string, patch: ApiKeyUpdatePatch): Promise<ApiKey<AccountActor>> {
        const row = await this.db
            .updateTable('wilson.apiKeys')
            .set({
                ...(patch.name === undefined ? {} : { name: patch.name }),
                ...(patch.scopes === undefined ? {} : { scopes: patch.scopes }),
                ...(patch.metadata === undefined ? {} : { metadata: JSON.stringify(patch.metadata) }),
                ...(patch.expiresAt === undefined ? {} : { expiresAt: patch.expiresAt ? patch.expiresAt : null }),
                ...(patch.secretHash === undefined ? {} : { secretHash: patch.secretHash }),
                ...(patch.hint === undefined ? {} : { hint: patch.hint }),
            })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
        return toKey(row);
    }

    async revoke(id: string, at: DateTime): Promise<ApiKey<AccountActor>> {
        const row = await this.db
            .updateTable('wilson.apiKeys')
            .set(eb => ({ revokedAt: eb.fn.coalesce('revokedAt', eb.val(at)) }))
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow();
        return toKey(row);
    }

    async revokeAllForOwner(owner: TargetActor<AccountActor>, at: DateTime): Promise<number> {
        const result = await this.db
            .updateTable('wilson.apiKeys')
            .set({ revokedAt: at })
            .where('accountId', '=', owner.actorId)
            .where('revokedAt', 'is', null)
            .executeTakeFirst();
        return Number(result.numUpdatedRows);
    }

    async touchLastUsed(id: string, at: DateTime): Promise<void> {
        await this.db.updateTable('wilson.apiKeys').set({ lastUsedAt: at }).where('id', '=', id).execute();
    }

    async delete(id: string): Promise<void> {
        await this.db.deleteFrom('wilson.apiKeys').where('id', '=', id).execute();
    }
}
