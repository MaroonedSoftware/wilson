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
 * What is shown of a saved secret: its name and when it was saved, never its value.
 * generated from [SecretSummary](../../../../apps/api/data/contracts/secrets.ck)
 */
export interface SecretSummary {
    name: string;
    createdAt: DateTime;
    updatedAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a SecretSummary into its runtime type. Mutates and returns `raw`. */
export function reviveSecretSummary(raw: SecretSummary): SecretSummary {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'SecretSummary.createdAt');
    __o0['updatedAt'] = __dt(__o0['updatedAt'], 'SecretSummary.updatedAt');
    return raw;
}

/**
 * generated from [PutSecretRequest](../../../../apps/api/data/contracts/secrets.ck)
 */
export interface PutSecretRequest {
    value: string;
}
