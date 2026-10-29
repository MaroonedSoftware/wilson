/**
 * What a key may do. `manage` includes `view`.
 * generated from [ApiKeyScope](file://./../../../../apps/api/data/contracts/api.keys.ck#L20)
 */
export type ApiKeyScope = 'view' | 'manage';

/**
 * A key as the list shows it. `hint` is the last few characters of the token, to tell keys apart.
 * generated from [ApiKeySummary](file://./../../../../apps/api/data/contracts/api.keys.ck#L23)
 */
export interface ApiKeySummary {
    id: string;
    name: string;
    hint: string;
    scope: ApiKeyScope;
    createdAt: string;
    expiresAt?: string;
    lastUsedAt?: string;
    revokedAt?: string;
}

/**
 * generated from [CreateApiKeyRequest](file://./../../../../apps/api/data/contracts/api.keys.ck#L34)
 */
export interface CreateApiKeyRequest {
    name: string;
    scope: ApiKeyScope;
    /** Unset means the key does not expire. */
    expiresInDays?: number;
}

/**
 * A newly created or rotated key and its token. The only time the token is ever returned.
 * generated from [IssuedApiKey](file://./../../../../apps/api/data/contracts/api.keys.ck#L42)
 */
export interface IssuedApiKey {
    key: ApiKeySummary;
    token: string;
}
