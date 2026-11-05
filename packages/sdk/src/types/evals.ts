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
 * One past attempt, kept to be run again. `warnings` is only ever filled when capturing one.
 * generated from [EvalFixture](../../../../apps/api/data/contracts/evals.ck)
 */
export interface EvalFixture {
    id: string;
    sourceCardId: string;
    title: string;
    stage: string;
    planVersionId: string;
    baseSha: string;
    headSha: string;
    warnings: string[];
    createdAt: DateTime;
}

/** Rehydrates every wire-encoded scalar in a EvalFixture into its runtime type. Mutates and returns `raw`. */
export function reviveEvalFixture(raw: EvalFixture): EvalFixture {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'EvalFixture.createdAt');
    return raw;
}

/**
 * `attempt` counts from 1, oldest first, and defaults to the card's latest attempt at that stage.
 * generated from [CaptureEvalFixtureRequest](../../../../apps/api/data/contracts/evals.ck)
 */
export interface CaptureEvalFixtureRequest {
    cardId: string;
    stage: string;
    attempt?: number;
}
