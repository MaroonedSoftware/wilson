import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { duration, timelineLines } from '#src/commands/card/timeline.command.js';

describe('wilson card timeline', () => {
    it('says durations in their two largest units', () => {
        expect(duration(12_000)).toBe('12s');
        expect(duration(250_000)).toBe('4m 10s');
        expect(duration(7_500_000)).toBe('2h 05m');
    });

    it('leads with the totals, then names repeated runs, then each stretch', () => {
        const startedAt = DateTime.utc(2026, 11, 7, 9, 0);
        const lines = timelineLines('0042', {
            spans: [
                {
                    kind: 'running',
                    stage: 'review',
                    step: 'challenge',
                    startedAt,
                    endedAt: startedAt.plus({ minutes: 3 }),
                    durationMs: 180_000,
                    outcome: 'passed',
                },
            ],
            totals: { queuedMs: 60_000, runningMs: 180_000, waitingOnPersonMs: 0, wallClockMs: 240_000 },
            reviewRounds: 2,
            kickbacks: 1,
            repeatedRuns: [{ stage: 'testing', count: 2 }],
            ended: false,
        });

        expect(lines[0]).toBe('0042: 4m 00s so far: running 3m 00s, queued 1m 00s, waiting on a person 0s');
        expect(lines[1]).toBe('review rounds: 2, kickbacks: 1');
        expect(lines[2]).toBe('ran again on unchanged code: testing x2');
        expect(lines[3]).toContain('review/challenge (passed)');
    });
});
