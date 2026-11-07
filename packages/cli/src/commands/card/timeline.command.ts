import type { CommandModule } from '@maroonedsoftware/johnny5';
import type { CardTimeline } from '@wilson/sdk';
import { withApi } from '../../api-client.js';

/** A duration as the largest two units that say it: `2h 05m`, `4m 10s`, `12s`. */
export const duration = (ms: number): string => {
    const seconds = Math.round(ms / 1000);
    const [h, m, s] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
};

const KIND: Record<CardTimeline['spans'][number]['kind'], string> = {
    queued: 'queued',
    running: 'running',
    waitingOnPerson: 'waiting on a person',
};

/** The lines `wilson card timeline` prints, so a test can read them without a logger. */
export const timelineLines = (cardId: string, timeline: CardTimeline): string[] => {
    const { totals } = timeline;
    const lines = [
        `${cardId}: ${duration(totals.wallClockMs)} ${timeline.ended ? 'from start to done' : 'so far'}: ` +
            `running ${duration(totals.runningMs)}, queued ${duration(totals.queuedMs)}, waiting on a person ${duration(totals.waitingOnPersonMs)}`,
        `review rounds: ${timeline.reviewRounds}, kickbacks: ${timeline.kickbacks}`,
    ];
    for (const repeat of timeline.repeatedRuns) {
        lines.push(`ran again on unchanged code: ${repeat.step ? `${repeat.stage}/${repeat.step}` : repeat.stage} x${repeat.count}`);
    }
    for (const span of timeline.spans) {
        const where = span.step ? `${span.stage}/${span.step}` : span.stage;
        lines.push(
            `  ${span.startedAt.toUTC().toISO({ suppressMilliseconds: true })}  ${duration(span.durationMs).padStart(8)}  ${KIND[span.kind].padEnd(19)} ${where}${span.outcome ? ` (${span.outcome})` : ''}`,
        );
    }
    return lines;
};

/** Where a card's time went: queued, running or waiting on a person, and any runs repeated on unchanged code. */
const command: CommandModule = {
    description: "Show where a card's time went: running, queued or waiting on a person",
    args: [{ name: 'cardId', description: 'The card id, e.g. 0001', required: true }],
    run: withApi(async (_opts, ctx, args, api) => {
        const cardId = String(args[0]);
        for (const line of timelineLines(cardId, await api.board.getCardTimeline(cardId))) ctx.logger.info(line);
        return 0;
    }),
};

export default command;
