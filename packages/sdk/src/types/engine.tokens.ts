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
 * What is shown of a saved token: its name and when it was saved, never the token.
 * generated from [EngineTokenSummary](../../../../apps/api/data/contracts/engine.tokens.ck)
 */
export interface EngineTokenSummary {
    name: string;
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
    /** What `claude setup-token` prints. */
    token: string;
}
