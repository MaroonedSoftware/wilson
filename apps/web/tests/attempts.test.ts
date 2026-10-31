import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { CardEvent } from '@wilson/sdk';
import { groupAttempts } from '#src/lib/attempts.js';

let nextId = 0;
const event = (type: string, stage: string, payload: CardEvent['payload'] = {}): CardEvent => ({
    id: String(++nextId),
    type,
    stage,
    payload,
    createdAt: DateTime.fromISO('2026-10-31T10:00:00Z'),
});

describe('groupAttempts', () => {
    it('gathers each run’s tool calls, usage and trace, newest first', () => {
        const attempts = groupAttempts([
            event('stage.dispatched', 'testing'),
            event('tool.executed', 'testing', { tool: 'Bash', command: 'pnpm test' }),
            event('tool.denied', 'testing', { tool: 'Bash', reason: 'no' }),
            event('stage.failed', 'testing', {
                failures: ['tests failed'],
                usage: { inputTokens: 900, outputTokens: 40 },
                trace: { reads: 3, readPaths: ['src/a.ts'], finalMessage: 'stopped' },
            }),
            event('stage.dispatched', 'testing'),
            event('stage.passed', 'testing', { failures: [], usage: { inputTokens: 100 } }),
        ]);

        expect(attempts.map(attempt => attempt.outcome)).toEqual(['passed', 'failed']);
        expect(attempts[1]).toMatchObject({
            toolCalls: 1,
            denials: 1,
            inputTokens: 900,
            reads: 3,
            readPaths: ['src/a.ts'],
            finalMessage: 'stopped',
            failures: ['tests failed'],
        });
    });

    it('calls the latest unended attempt running, and an earlier one interrupted', () => {
        const attempts = groupAttempts([event('stage.dispatched', 'review'), event('stage.dispatched', 'review')]);

        expect(attempts.map(attempt => attempt.outcome)).toEqual(['running', 'interrupted']);
    });

    it('ignores events from before the first dispatch in a tail of the history', () => {
        const attempts = groupAttempts([event('tool.executed', 'testing'), event('stage.passed', 'testing')]);

        expect(attempts).toEqual([]);
    });

    it('reads an attempt from before traces existed, with no reads figure', () => {
        const [attempt] = groupAttempts([event('stage.dispatched', 'testing'), event('stage.passed', 'testing', { failures: [] })]);

        expect(attempt?.reads).toBeUndefined();
        expect(attempt?.readPaths).toEqual([]);
    });
});
