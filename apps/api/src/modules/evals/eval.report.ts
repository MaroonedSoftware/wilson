import type { EvalArm, EvalRunRow } from './eval.run.repository.js';

export interface EvalSpread {
    median: number;
    min: number;
    max: number;
}

/** One arm on one fixture. Counts, and spreads over the runs that reached a verdict. */
export interface EvalArmSummary {
    fixtureId: string;
    arm: EvalArm;
    passed: number;
    failed: number;
    errored: number;
    /** Interrupted or abandoned: says nothing about the arm, so counted apart. */
    interrupted: number;
    pending: number;
    outputTokens?: EvalSpread;
    wallClockMs?: EvalSpread;
    failures: { reason: string; count: number }[];
}

const spread = (values: number[]): EvalSpread | undefined => {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
    return { median, min: sorted[0]!, max: sorted[sorted.length - 1]! };
};

/**
 * A batch's results per fixture and arm. Deliberately no verdict: with a handful of runs each, the
 * honest report is the counts and the spread, for a person to read against an A/A batch's noise.
 */
export const summarizeRuns = (runs: readonly EvalRunRow[]): EvalArmSummary[] => {
    const groups = new Map<string, EvalRunRow[]>();
    for (const run of runs) {
        const key = `${run.fixtureId}:${run.arm}`;
        groups.set(key, [...(groups.get(key) ?? []), run]);
    }

    return [...groups.values()].map(group => {
        const judged = group.filter(run => run.status === 'passed' || run.status === 'failed');
        const count = (...statuses: EvalRunRow['status'][]) => group.filter(run => statuses.includes(run.status)).length;
        const reasons = new Map<string, number>();
        for (const run of judged) for (const reason of run.failures) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        const outputTokens = spread(judged.flatMap(run => (run.outputTokens === undefined ? [] : [run.outputTokens])));
        const wallClockMs = spread(judged.flatMap(run => (run.wallClockMs === undefined ? [] : [run.wallClockMs])));
        return {
            fixtureId: group[0]!.fixtureId,
            arm: group[0]!.arm,
            passed: count('passed'),
            failed: count('failed'),
            errored: count('errored'),
            interrupted: count('interrupted', 'abandoned'),
            pending: count('queued', 'running', 'skipped'),
            ...(outputTokens && { outputTokens }),
            ...(wallClockMs && { wallClockMs }),
            failures: [...reasons].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count),
        };
    });
};
