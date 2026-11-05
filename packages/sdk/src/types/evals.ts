import { DateTime } from 'luxon';
import type { JsonValue } from '../sdk-options.js';

const __dt = (v: unknown, path: string): DateTime => {
    if (typeof v !== 'string') {
        throw new TypeError(`ContractKit: expected an ISO 8601 string at '${path}', received ${typeof v}.`);
    }
    const d = DateTime.fromISO(v);
    if (!d.isValid) throw new TypeError(`ContractKit: '${v}' at '${path}' is not a valid ISO 8601 datetime.`);
    return d;
};

/**
 * What a review of a fixture should find. `blockerFiles` empty means any blocker counts. `source` says
 * whether this came from the card's own review or from a person, since only a person's word is more
 * than the model agreeing with itself.
 * generated from [EvalExpected](../../../../apps/api/data/contracts/evals.ck)
 */
export interface EvalExpected {
    verdict: 'pass' | 'revise';
    blockerFiles: string[];
    source: 'attempt' | 'operator';
}

/**
 * generated from [SetEvalFixtureExpectedRequest](../../../../apps/api/data/contracts/evals.ck)
 */
export interface SetEvalFixtureExpectedRequest {
    verdict: 'pass' | 'revise';
    blockerFiles?: string[];
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

/**
 * A change to try on one lane, never saved. With nothing but `lane` it changes nothing, which makes an
 * A/A batch: both arms the same, to measure how much runs differ by chance.
 * generated from [LaneCandidate](../../../../apps/api/data/contracts/evals.ck)
 */
export interface LaneCandidate {
    lane: string;
    instructions?: string;
    settings?: JsonValue;
    adapter?: string;
    provider?: string;
    model?: string;
}

/**
 * One run of one fixture. `interrupted` and `abandoned` say nothing about the config, and are counted
 * apart from `passed` and `failed`.
 * generated from [EvalRun](../../../../apps/api/data/contracts/evals.ck)
 */
export interface EvalRun {
    id: string;
    fixtureId: string;
    arm: 'current' | 'candidate';
    status: 'queued' | 'running' | 'passed' | 'failed' | 'errored' | 'interrupted' | 'abandoned' | 'skipped';
    failures: string[];
    unjudged: boolean;
    reportRejected: boolean;
    truncated: boolean;
    hasPatch: boolean;
    error?: string;
    wallClockMs?: number;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    toolCalls?: number;
    scopeDenials?: number;
}

/**
 * generated from [EvalSpread](../../../../apps/api/data/contracts/evals.ck)
 */
export interface EvalSpread {
    median: number;
    min: number;
    max: number;
}

/**
 * How review runs' conclusions compared with what their fixture expected.
 * generated from [EvalScore](../../../../apps/api/data/contracts/evals.ck)
 */
export interface EvalScore {
    caught: number;
    missed: number;
    falseAlarms: number;
    clean: number;
    unscored: number;
}

/**
 * generated from [EvalFailureCount](../../../../apps/api/data/contracts/evals.ck)
 */
export interface EvalFailureCount {
    reason: string;
    count: number;
}

/**
 * generated from [EvalRunPatch](../../../../apps/api/data/contracts/evals.ck)
 */
export interface EvalRunPatch {
    patch: string;
    truncated: boolean;
}

/**
 * generated from [ListEvalBatchesQuery](../../../../apps/api/data/contracts/evals.ck)
 */
export interface ListEvalBatchesQuery {
    limit?: number;
}

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
    expected?: EvalExpected;
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
 * One batch: fixtures run again on one host, up to a limit on what it spends. `waitingReason` says why
 * nothing is running right now, such as a host with no slot free.
 * generated from [EvalBatch](../../../../apps/api/data/contracts/evals.ck)
 */
export interface EvalBatch {
    id: string;
    status: 'running' | 'finished' | 'stopped';
    host: string;
    runsPerFixture: number;
    maxOutputTokens: number;
    spentOutputTokens: number;
    candidate?: LaneCandidate;
    stopReason?: string;
    waitingReason?: string;
    createdAt: DateTime;
    finishedAt?: DateTime;
}

/** Rehydrates every wire-encoded scalar in a EvalBatch into its runtime type. Mutates and returns `raw`. */
export function reviveEvalBatch(raw: EvalBatch): EvalBatch {
    const __o0 = raw as unknown as Record<string, unknown>;
    __o0['createdAt'] = __dt(__o0['createdAt'], 'EvalBatch.createdAt');
    if (__o0['finishedAt'] != null) {
        __o0['finishedAt'] = __dt(__o0['finishedAt'], 'EvalBatch.finishedAt');
    }
    return raw;
}

/**
 * `runs` is per fixture and per arm, and defaults to 3. `maxOutputTokens` defaults to 300000. With a
 * `candidate`, every fixture must be an attempt at the lane it changes, and the arms alternate.
 * generated from [CreateEvalBatchRequest](../../../../apps/api/data/contracts/evals.ck)
 */
export interface CreateEvalBatchRequest {
    fixtureIds: string[];
    host: string;
    candidate?: LaneCandidate;
    runs?: number;
    maxOutputTokens?: number;
}

/**
 * One arm across every fixture in the batch.
 * generated from [EvalArmTotal](../../../../apps/api/data/contracts/evals.ck)
 */
export interface EvalArmTotal {
    arm: 'current' | 'candidate';
    passed: number;
    failed: number;
    errored: number;
    interrupted: number;
    pending: number;
    outputTokens?: EvalSpread;
    wallClockMs?: EvalSpread;
    score?: EvalScore;
}

/**
 * One arm on one fixture. There is no verdict here on purpose: with a handful of runs, the honest
 * report is the counts and the spread.
 * generated from [EvalArmSummary](../../../../apps/api/data/contracts/evals.ck)
 */
export interface EvalArmSummary {
    fixtureId: string;
    arm: 'current' | 'candidate';
    passed: number;
    failed: number;
    errored: number;
    interrupted: number;
    pending: number;
    outputTokens?: EvalSpread;
    wallClockMs?: EvalSpread;
    score?: EvalScore;
    failures: EvalFailureCount[];
}

/**
 * generated from [EvalBatchDetail](../../../../apps/api/data/contracts/evals.ck)
 */
export interface EvalBatchDetail {
    batch: EvalBatch;
    runs: EvalRun[];
    summary: EvalArmSummary[];
    totals: EvalArmTotal[];
}

/** Rehydrates every wire-encoded scalar in a EvalBatchDetail into its runtime type. Mutates and returns `raw`. */
export function reviveEvalBatchDetail(raw: EvalBatchDetail): EvalBatchDetail {
    const __o0 = raw as unknown as Record<string, unknown>;
    reviveEvalBatch(__o0['batch'] as never);
    return raw;
}
