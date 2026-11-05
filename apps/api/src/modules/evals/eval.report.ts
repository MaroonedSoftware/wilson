import type { EvalExpected } from './eval.attempt.js';
import type { EvalArm, EvalRunRow } from './eval.run.repository.js';

/** How a review run's conclusion compared with what its fixture expected. */
export interface EvalScore {
    /** Expected a blocker, and it named one where expected. */
    caught: number;
    /** Expected a blocker, and it passed or named one somewhere else. */
    missed: number;
    /** Expected a pass, and it asked for changes. */
    falseAlarms: number;
    /** Expected a pass, and it passed. */
    clean: number;
    /** Reached no coherent conclusion to compare. */
    unscored: number;
}

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
    score?: EvalScore;
    failures: { reason: string; count: number }[];
}

const spread = (values: number[]): EvalSpread | undefined => {
    if (values.length === 0) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
    return { median, min: sorted[0]!, max: sorted[sorted.length - 1]! };
};

/** One arm across every fixture. */
export type EvalArmTotal = Omit<EvalArmSummary, 'fixtureId' | 'failures'>;

type ScoreKey = keyof EvalScore;

/** Which bucket one run falls in. Only a run that finished with a report it stands behind has a conclusion. */
export const scoreRun = (expected: EvalExpected, run: EvalRunRow): ScoreKey => {
    const { verdict, findings } = (run.result ?? {}) as { verdict?: unknown; findings?: unknown };
    if (run.unjudged || (verdict !== 'pass' && verdict !== 'revise')) return 'unscored';
    if (expected.verdict === 'pass') return verdict === 'pass' ? 'clean' : 'falseAlarms';
    if (verdict === 'pass') return 'missed';
    if (expected.blockerFiles.length === 0) return 'caught';
    const list = Array.isArray(findings) ? (findings as { severity?: unknown; file?: unknown }[]) : [];
    return list.some(finding => finding.severity === 'blocker' && expected.blockerFiles.includes(finding.file as string)) ? 'caught' : 'missed';
};

/** The scores of the runs whose fixture expects something. Absent when none does. */
const scoresOf = (group: readonly EvalRunRow[], expected: ReadonlyMap<string, EvalExpected>): EvalScore | undefined => {
    const scored = group.filter(run => expected.has(run.fixtureId) && (run.status === 'passed' || run.status === 'failed'));
    if (![...new Set(group.map(run => run.fixtureId))].some(id => expected.has(id))) return undefined;
    const score: EvalScore = { caught: 0, missed: 0, falseAlarms: 0, clean: 0, unscored: 0 };
    for (const run of scored) score[scoreRun(expected.get(run.fixtureId)!, run)] += 1;
    return score;
};

const countsOf = (group: readonly EvalRunRow[]): Omit<EvalArmTotal, 'arm'> => {
    const judged = group.filter(run => run.status === 'passed' || run.status === 'failed');
    const count = (...statuses: EvalRunRow['status'][]) => group.filter(run => statuses.includes(run.status)).length;
    const outputTokens = spread(judged.flatMap(run => (run.outputTokens === undefined ? [] : [run.outputTokens])));
    const wallClockMs = spread(judged.flatMap(run => (run.wallClockMs === undefined ? [] : [run.wallClockMs])));
    return {
        passed: count('passed'),
        failed: count('failed'),
        errored: count('errored'),
        interrupted: count('interrupted', 'abandoned'),
        pending: count('queued', 'running', 'skipped'),
        ...(outputTokens && { outputTokens }),
        ...(wallClockMs && { wallClockMs }),
    };
};

/** Each arm across the whole batch, current first. */
export const totalRuns = (runs: readonly EvalRunRow[], expected: ReadonlyMap<string, EvalExpected> = new Map()): EvalArmTotal[] =>
    (['current', 'candidate'] as const).flatMap(arm => {
        const group = runs.filter(run => run.arm === arm);
        if (group.length === 0) return [];
        const score = scoresOf(group, expected);
        return [{ arm, ...countsOf(group), ...(score && { score }) }];
    });

/**
 * A batch's results per fixture and arm. Deliberately no verdict: with a handful of runs each, the
 * honest report is the counts and the spread, for a person to read against an A/A batch's noise.
 */
export const summarizeRuns = (runs: readonly EvalRunRow[], expected: ReadonlyMap<string, EvalExpected> = new Map()): EvalArmSummary[] => {
    const groups = new Map<string, EvalRunRow[]>();
    for (const run of runs) {
        const key = `${run.fixtureId}:${run.arm}`;
        groups.set(key, [...(groups.get(key) ?? []), run]);
    }

    return [...groups.values()].map(group => {
        const reasons = new Map<string, number>();
        for (const run of group) {
            if (run.status === 'passed' || run.status === 'failed') {
                for (const reason of run.failures) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
            }
        }
        const score = scoresOf(group, expected);
        return {
            fixtureId: group[0]!.fixtureId,
            arm: group[0]!.arm,
            ...countsOf(group),
            ...(score && { score }),
            failures: [...reasons].map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count),
        };
    });
};
