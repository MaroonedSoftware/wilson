import { createHash, randomBytes } from 'node:crypto';

/**
 * What every worker token starts with, so one pasted somewhere it should not be is recognisable for
 * what it is, and is never mistaken for an API key.
 */
export const WORKER_TOKEN_PREFIX = 'wilson_worker_';

/** A freshly minted worker token: the secret, shown once, and what is kept of it. */
export interface MintedWorkerToken {
    token: string;
    hash: string;
    hint: string;
}

/** A new token for a worker host: 32 random bytes, base64url, behind {@link WORKER_TOKEN_PREFIX}. */
export const mintWorkerToken = (): MintedWorkerToken => {
    const token = `${WORKER_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    return { token, hash: hashWorkerToken(token), hint: token.slice(-4) };
};

/**
 * What `runner.hosts.worker_token_hash` holds for `token`. A plain SHA-256 rather than a slow
 * password hash, as for API keys: the token is 256 random bits, not something a person chose, so
 * there is nothing for a slow hash to protect, and a lookup by hash needs it to be deterministic.
 */
export const hashWorkerToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
