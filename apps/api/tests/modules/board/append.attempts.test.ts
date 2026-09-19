import { describe, expect, it } from 'vitest';
import { withAttempt, withoutAttempts, type Attempt } from '#modules/board/append.attempts.js';

const attempt = (overrides: Partial<Attempt> = {}): Attempt => ({
    stage: 'implementing',
    attempt: 1,
    maxKickbacks: 3,
    date: '2026-01-01T00:00:00.000Z',
    failures: ['diff was empty'],
    ...overrides,
});

describe('withAttempt', () => {
    it('appends a "## Previous attempts" section to a body with no existing section (AC1)', () => {
        const body = '## Goal\n\nDo the thing.';

        const result = withAttempt(body, attempt());

        expect(result).toBe(
            '## Goal\n\nDo the thing.\n\n## Previous attempts\n\n' +
                '- **implementing** attempt 1 of 3 (2026-01-01T00:00:00.000Z): No summary reported. Failures: diff was empty.',
        );
    });

    it('names the stage, "attempt N of M", and the failures in one bullet', () => {
        const body = '## Goal\n\nDo the thing.';

        const result = withAttempt(
            body,
            attempt({ stage: 'testing', attempt: 2, maxKickbacks: 5, failures: ['tests failed: 3 red', 'build failed: type error'] }),
        );

        expect(result).toContain('**testing** attempt 2 of 5');
        expect(result).toContain('tests failed: 3 red');
        expect(result).toContain('build failed: type error');
    });

    it('falls back to "No summary reported." when no summary was given, and trims one that was', () => {
        const withoutSummary = withAttempt('body', attempt());
        expect(withoutSummary).toContain('No summary reported.');

        const withSummary = withAttempt('body', attempt({ summary: '  fixed the off-by-one  ' }));
        expect(withSummary).toContain(': fixed the off-by-one Failures:');
        expect(withSummary).not.toContain('No summary reported.');
        // Trimmed, not left with two spaces where the leading/trailing whitespace was stripped.
        expect(withSummary).not.toContain('  fixed');
        expect(withSummary).not.toContain('off-by-one  ');
    });

    it('includes the engine stop reason and the patch path when both are given, in prose form', () => {
        const result = withAttempt(
            'body',
            attempt({
                engineStopReason: 'max_tokens',
                patchPath: '/run/cards/0007/last-failed-attempt.patch',
            }),
        );

        expect(result).toContain('Engine stopped: max_tokens.');
        expect(result).toContain('Uncommitted work preserved at `/run/cards/0007/last-failed-attempt.patch`.');
    });

    it('omits the engine-stopped and patch-preserved sentences entirely when neither is given', () => {
        const result = withAttempt('body', attempt());

        expect(result).not.toContain('Engine stopped');
        expect(result).not.toContain('preserved at');
    });

    it('truncates a failure’s first line to ~200 characters', () => {
        const long = 'x'.repeat(250);

        const result = withAttempt('body', attempt({ failures: [long] }));

        // Cut to 200 characters plus the ellipsis marker, not the full 250.
        expect(result).toContain(`${'x'.repeat(200)}…`);
        expect(result).not.toContain('x'.repeat(201));
    });

    it('uses only the first line of a multi-line failure string', () => {
        const result = withAttempt('body', attempt({ failures: ['first line of the failure\nsome stack trace\nmore stack trace'] }));

        expect(result).toContain('first line of the failure');
        expect(result).not.toContain('some stack trace');
        expect(result).not.toContain('more stack trace');
    });

    it('keeps at most five failures per bullet', () => {
        const failures = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'];

        const result = withAttempt('body', attempt({ failures }));

        expect(result).toContain('f1');
        expect(result).toContain('f5');
        expect(result).not.toContain('f6');
        expect(result).not.toContain('f7');
    });

    it('adds a second bullet ahead of the existing one rather than replacing it (AC2)', () => {
        const body = '## Goal\n\nDo the thing.';

        const first = withAttempt(body, attempt({ attempt: 1, failures: ['first failure'] }));
        const second = withAttempt(first, attempt({ attempt: 2, failures: ['second failure'] }));

        expect(second).toContain('attempt 1 of 3');
        expect(second).toContain('first failure');
        expect(second).toContain('attempt 2 of 3');
        expect(second).toContain('second failure');
        // Exactly one heading, however many bullets have accumulated under it.
        expect(second.match(/## Previous attempts/g)).toHaveLength(1);
        // The earlier bullet still precedes the later one.
        expect(second.indexOf('attempt 1 of 3')).toBeLessThan(second.indexOf('attempt 2 of 3'));
    });

    it('leaves content after the section untouched, restoring the boundary at the next heading', () => {
        const body = [
            '## Goal',
            '',
            'Do the thing.',
            '',
            '## Previous attempts',
            '',
            '- **implementing** attempt 1 of 3 (2026-01-01T00:00:00.000Z): No summary reported. Failures: old failure.',
            '',
            '## Constraints',
            '',
            'Do not break anything.',
        ].join('\n');

        const result = withAttempt(body, attempt({ attempt: 2, failures: ['new failure'] }));

        expect(result).toContain('## Constraints\n\nDo not break anything.');
        expect(result).toContain('old failure');
        expect(result).toContain('new failure');
    });

    it('does not add a leading blank line when the body already ends with one', () => {
        const body = '## Goal\n\nDo the thing.\n';

        const result = withAttempt(body, attempt());

        expect(result).toBe(
            '## Goal\n\nDo the thing.\n\n## Previous attempts\n\n' +
                '- **implementing** attempt 1 of 3 (2026-01-01T00:00:00.000Z): No summary reported. Failures: diff was empty.',
        );
    });
});

describe('withoutAttempts', () => {
    it('removes the section entirely, restoring the body to what preceded it (AC3)', () => {
        const body = [
            '## Goal',
            '',
            'Do the thing.',
            '',
            '## Previous attempts',
            '',
            '- **implementing** attempt 1 of 3 (2026-01-01T00:00:00.000Z): No summary reported. Failures: old failure.',
            '',
            '## Constraints',
            '',
            'Do not break anything.',
        ].join('\n');

        const result = withoutAttempts(body);

        expect(result).toBe('## Goal\n\nDo the thing.\n\n## Constraints\n\nDo not break anything.');
        expect(result).not.toContain('Previous attempts');
        expect(result).not.toContain('old failure');
    });

    it('round-trips unchanged a body with no "## Previous attempts" heading (AC6)', () => {
        const body = '## Goal\n\nDo the thing.\n\n## Constraints\n\nDo not break anything.';

        expect(withoutAttempts(body)).toBe(body);
    });

    it('is a no-op on an empty body', () => {
        expect(withoutAttempts('')).toBe('');
    });
});
