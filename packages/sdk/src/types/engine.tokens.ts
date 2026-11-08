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
 * Who a token signs in to.
 * generated from [EngineTokenProvider](../../../../apps/api/data/contracts/engine.tokens.ck)
 */
export type EngineTokenProvider = 'anthropic' | 'openai' | 'xai';

/**
 * How it signs in: a plan's own login, or a key billed per token.
 * generated from [EngineTokenKind](../../../../apps/api/data/contracts/engine.tokens.ck)
 */
export type EngineTokenKind = 'subscription' | 'api_key';

/**
 * The name to hold a saved token under from now on.
 * generated from [RenameEngineTokenRequest](../../../../apps/api/data/contracts/engine.tokens.ck)
 */
export interface RenameEngineTokenRequest {
    name: string;
}

/**
 * A usage limit an account has hit that has not reset. `account` is a saved token's name, `local` for
 * the sign-in of engines on this machine, or `worker:<host>` for a worker's own.
 * generated from [EngineLimit](../../../../apps/api/data/contracts/engine.tokens.ck)
 */
export interface EngineLimit {
    account: string;
    limitType: string;
    resetsAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a EngineLimit into its runtime type. Mutates and returns `raw`. */
export function reviveEngineLimit(raw: EngineLimit): EngineLimit {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['resetsAt'] = __dt(__o0['resetsAt'], 'EngineLimit.resetsAt');
    return raw;
}

/**
 * How many days `GET /api/engine-accounts/usage` reads, today included. Defaults to 30, and is held to
 * between 1 and 365. A day starts at the server's midnight, as in `GET /api/stats`.
 * generated from [EngineAccountUsageQuery](../../../../apps/api/data/contracts/engine.tokens.ck)
 */
export interface EngineAccountUsageQuery {
    days?: number;
}

/**
 * What one engine account spent, across every project: stage runs, chat turns and planning turns. `account`
 * is named as `EngineLimit.account` is. `inputTokens` includes `cachedInputTokens`, as in `ProjectStatsCounts`.
 * Spend recorded before accounts were named, by the `api` engine, by a rule judge, or in a review
 * conversation, is in no row.
 * generated from [EngineAccountUsage](../../../../apps/api/data/contracts/engine.tokens.ck)
 */
export interface EngineAccountUsage {
    account: string;
    /** Output tokens since the server's midnight. */
    todayOutputTokens: number;
    /** The rest are over the whole window. */
    outputTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
}

/**
 * What is shown of a saved token: its name, what it signs in to and when it was saved, never the token.
 * generated from [EngineTokenSummary](../../../../apps/api/data/contracts/engine.tokens.ck)
 */
export interface EngineTokenSummary {
    name: string;
    provider: EngineTokenProvider;
    kind: EngineTokenKind;
    /** Which of a provider's tokens comes first, lowest first. */
    priority: number;
    /** Whether Wilson may choose this token for an engine with no token assigned. */
    pooled: boolean;
    createdAt: DateTime;
    updatedAt: DateTime;
    /** The worker hosts assigned this token, name ascending. */
    hosts: string[];
}

/** Rehydrates every wire-encoded scalar in a EngineTokenSummary into its runtime type. Mutates and returns `raw`. */
export function reviveEngineTokenSummary(raw: EngineTokenSummary): EngineTokenSummary {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'EngineTokenSummary.createdAt');
    __o0['updatedAt'] = __dt(__o0['updatedAt'], 'EngineTokenSummary.updatedAt');
    return raw;
}

/**
 * generated from [PutEngineTokenRequest](../../../../apps/api/data/contracts/engine.tokens.ck)
 */
export interface PutEngineTokenRequest {
    /** What `claude setup-token` prints, or an API key. An OpenAI token has to be an API key. */
    token: string;
    /**
     * Each of these keeps what is saved under this name when left out, or its default on a new name:
     * anthropic, subscription, 0 and not pooled.
     */
    provider?: EngineTokenProvider;
    kind?: EngineTokenKind;
    /** 0 to 1000. */
    priority?: number;
    pooled?: boolean;
}

/**
 * What can change about a saved token without saving it again. What is left out stays as it is.
 * generated from [UpdateEngineTokenRequest](../../../../apps/api/data/contracts/engine.tokens.ck)
 */
export interface UpdateEngineTokenRequest {
    provider?: EngineTokenProvider;
    kind?: EngineTokenKind;
    /** 0 to 1000. */
    priority?: number;
    pooled?: boolean;
}
