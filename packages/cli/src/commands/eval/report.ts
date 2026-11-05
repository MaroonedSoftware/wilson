import type { EvalArmSummary, EvalBatchDetail, EvalSpread } from '@wilson/sdk';

const spread = (value: EvalSpread | undefined, unit: string): string => (value ? `${value.median}${unit} (${value.min}-${value.max})` : '-');

const seconds = (value: EvalSpread | undefined): EvalSpread | undefined =>
    value && { median: Math.round(value.median / 1000), min: Math.round(value.min / 1000), max: Math.round(value.max / 1000) };

const armLine = (summary: EvalArmSummary): string => {
    const judged = summary.passed + summary.failed;
    const apart = [
        summary.errored > 0 ? `${summary.errored} errored` : '',
        summary.interrupted > 0 ? `${summary.interrupted} interrupted` : '',
        summary.pending > 0 ? `${summary.pending} not run` : '',
    ].filter(Boolean);
    return [
        `  ${summary.arm.padEnd(10)}`,
        `passed ${summary.passed}/${judged}`.padEnd(14),
        `output ${spread(summary.outputTokens, '')}`.padEnd(30),
        `time ${spread(seconds(summary.wallClockMs), 's')}`,
        ...(apart.length > 0 ? [`[${apart.join(', ')}]`] : []),
    ].join(' ');
};

/**
 * A batch as text. Counts and spreads with no verdict: with a handful of runs each, whether a gap
 * means anything is for a person to judge against an A/A batch's noise.
 */
export const renderBatch = ({ batch, runs, summary }: EvalBatchDetail): string => {
    const lines = [`batch ${batch.id}: ${batch.status} on ${batch.host}, ${batch.spentOutputTokens}/${batch.maxOutputTokens} output tokens`];
    if (batch.stopReason) lines.push(`stopped: ${batch.stopReason}`);
    if (batch.waitingReason) lines.push(`waiting: ${batch.waitingReason}`);
    for (const fixtureId of new Set(summary.map(row => row.fixtureId))) {
        lines.push('', `fixture ${fixtureId}`);
        for (const row of summary.filter(candidate => candidate.fixtureId === fixtureId)) {
            lines.push(armLine(row));
            for (const { reason, count } of row.failures) lines.push(`    ${count}x ${reason}`);
        }
    }
    const errors = runs.filter(run => run.error);
    if (errors.length > 0) {
        lines.push('', 'runs that reached no verdict');
        for (const run of errors) lines.push(`  run ${run.id} (${run.status}): ${run.error}`);
    }
    return `${lines.join('\n')}\n`;
};
