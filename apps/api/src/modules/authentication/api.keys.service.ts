import { Injectable } from 'injectkit';
import { DateTime } from 'luxon';
import { ApiKeyService, type ApiKey } from '@maroonedsoftware/authentication';
import { httpError } from '@maroonedsoftware/errors';
import { ServerKitContext } from '@maroonedsoftware/koa';
import type { ApiKeySummary, CreateApiKeyRequest, IssuedApiKey } from '../../generated/api.keys.js';
import { ACCOUNT_ACTOR, type AccountActor } from './api.key.repository.js';
import { requireSession } from './request.session.js';

/** What a key may do. `manage` implies `view`; rollout step 6 is what reads them. */
export const API_KEY_SCOPES = ['view', 'manage'] as const;

const toSummary = (key: ApiKey<AccountActor>): ApiKeySummary => ({
    id: key.id,
    name: key.name,
    hint: key.hint,
    scope: key.scopes.includes('manage') ? 'manage' : 'view',
    createdAt: key.createdAt,
    ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
    ...(key.lastUsedAt ? { lastUsedAt: key.lastUsedAt } : {}),
    ...(key.revokedAt ? { revokedAt: key.revokedAt } : {}),
});

/**
 * The operator's API keys (`/api/auth/keys`): what the CLI and scripts authenticate with.
 *
 * A key cannot mint or rotate a key: those routes are gated `wilson.step.up` (`api.keys.ck`), which
 * only a session that proved a factor in the last five minutes satisfies. Otherwise one leaked key
 * could be turned into as many as its holder liked, each surviving the revocation of the first. A
 * key may list keys and revoke one, its own included, since revoking only ever takes authority away.
 *
 * Takes `ServerKitContext`, so the container wiring test exempts it, as it does
 * `CurrentSessionService`.
 */
@Injectable()
export class ApiKeysService {
    constructor(
        private readonly context: ServerKitContext,
        private readonly keys: ApiKeyService<AccountActor>,
    ) {}

    private owner() {
        return { kind: ACCOUNT_ACTOR, actorId: requireSession(this.context).subject } as const;
    }

    /** The key, if the caller owns it; 404 otherwise, so an id that is not yours reads as unknown. */
    private async ownKey(id: string): Promise<ApiKey<AccountActor>> {
        const key = await this.keys.get(id);
        if (!key || key.owner.actorId !== this.owner().actorId) throw httpError(404).withDetails({ reason: `no API key ${id}` });
        return key;
    }

    async list(): Promise<ApiKeySummary[]> {
        return (await this.keys.listForOwner(this.owner(), { includeInactive: true })).map(toSummary);
    }

    async create(request: CreateApiKeyRequest): Promise<IssuedApiKey> {
        const name = request.name.trim();
        if (name.length === 0) throw httpError(400).withDetails({ reason: 'name must not be blank' });
        const issued = await this.keys.create({
            owner: this.owner(),
            name,
            scopes: request.scope === 'manage' ? ['view', 'manage'] : ['view'],
            ...(request.expiresInDays === undefined ? {} : { expiresAt: DateTime.utc().plus({ days: request.expiresInDays }) }),
        });
        return { key: toSummary(issued.key), token: issued.token };
    }

    /** A new secret for the same key. The old token stops working at once. */
    async rotate(id: string): Promise<IssuedApiKey> {
        await this.ownKey(id);
        const issued = await this.keys.rotate(id);
        return { key: toSummary(issued.key), token: issued.token };
    }

    async revoke(id: string): Promise<ApiKeySummary> {
        await this.ownKey(id);
        return toSummary(await this.keys.revoke(id));
    }
}
