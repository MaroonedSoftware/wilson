import { DateTime } from 'luxon';
const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * What a key may do. `manage` includes `view`.
 * generated from [ApiKeyScope](../../../../apps/api/data/contracts/api.keys.ck)
 */
export type ApiKeyScope = 'view' | 'manage';

/**
 * A key as the list shows it. `hint` is the last few characters of the token, to tell keys apart.
 * generated from [ApiKeySummary](../../../../apps/api/data/contracts/api.keys.ck)
 */
export interface ApiKeySummary {
    id: string;
    name: string;
    hint: string;
    scope: ApiKeyScope;
    createdAt: DateTime;
    expiresAt?: DateTime;
    lastUsedAt?: DateTime;
    revokedAt?: DateTime;
}

/** Rehydrates every wire-encoded scalar in a ApiKeySummary into its runtime type. Mutates and returns `raw`. */
export function reviveApiKeySummary(raw: ApiKeySummary): ApiKeySummary {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'ApiKeySummary.createdAt');
    if (__o0['expiresAt'] != null) {
        __o0['expiresAt'] = __dt(__o0['expiresAt'], 'ApiKeySummary.expiresAt');
    }
    if (__o0['lastUsedAt'] != null) {
        __o0['lastUsedAt'] = __dt(__o0['lastUsedAt'], 'ApiKeySummary.lastUsedAt');
    }
    if (__o0['revokedAt'] != null) {
        __o0['revokedAt'] = __dt(__o0['revokedAt'], 'ApiKeySummary.revokedAt');
    }
    return raw;
}

/**
 * generated from [CreateApiKeyRequest](../../../../apps/api/data/contracts/api.keys.ck)
 */
export interface CreateApiKeyRequest {
    name: string;
    scope: ApiKeyScope;
    /** Unset means the key does not expire. */
    expiresInDays?: number;
}

/**
 * A newly created or rotated key and its token. The only time the token is ever returned.
 * generated from [IssuedApiKey](../../../../apps/api/data/contracts/api.keys.ck)
 */
export interface IssuedApiKey {
    key: ApiKeySummary;
    token: string;
}

/** Rehydrates every wire-encoded scalar in a IssuedApiKey into its runtime type. Mutates and returns `raw`. */
export function reviveIssuedApiKey(raw: IssuedApiKey): IssuedApiKey {
    const __o0 = raw as unknown as Record<string, unknown>;
    reviveApiKeySummary(__o0['key'] as never);
    return raw;
}
