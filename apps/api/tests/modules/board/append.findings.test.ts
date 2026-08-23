import { describe, expect, it } from 'vitest';
import { withFindings } from '#modules/board/append.findings.js';
import type { ReviewFinding } from '#modules/stages/stage.result.js';

const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
    severity: 'blocker',
    file: 'src/thing.ts',
    line: 12,
    problem: 'the thing is broken',
    suggestion: 'fix the thing',
    ...overrides,
});

describe('withFindings', () => {
    it('appends a findings section to a body with no existing section', () => {
        const body = '## Goal\n\nDo the thing.';

        const result = withFindings(body, [finding()]);

        expect(result).toBe(
            '## Goal\n\nDo the thing.\n\n## Review findings\n\n' + '- **blocker** `src/thing.ts:12`: the thing is broken — fix the thing',
        );
    });

    it('formats one bullet per finding, in order, with severity and file:line', () => {
        const body = 'Some body text.';
        const findings = [
            finding({ severity: 'blocker', file: 'a.ts', line: 1, problem: 'p1', suggestion: 's1' }),
            finding({ severity: 'concern', file: 'b.ts', line: 2, problem: 'p2', suggestion: 's2' }),
        ];

        const result = withFindings(body, findings);

        expect(result).toBe('Some body text.\n\n## Review findings\n\n' + '- **blocker** `a.ts:1`: p1 — s1\n' + '- **concern** `b.ts:2`: p2 — s2');
    });

    it('replaces an existing findings section rather than duplicating it', () => {
        const body = ['## Goal', '', 'Do the thing.', '', '## Review findings', '', '- **blocker** `old.ts:1`: stale problem — stale fix'].join('\n');

        const result = withFindings(body, [finding({ file: 'new.ts', line: 5, problem: 'fresh problem', suggestion: 'fresh fix' })]);

        expect(result).toContain('## Review findings\n\n- **blocker** `new.ts:5`: fresh problem — fresh fix');
        expect(result).not.toContain('old.ts');
        // Only ever one findings section, however many times a card has been kicked back.
        expect(result.match(/## Review findings/g)).toHaveLength(1);
    });

    it('leaves content after the findings section untouched, restoring the boundary at the next heading', () => {
        const body = [
            '## Goal',
            '',
            'Do the thing.',
            '',
            '## Review findings',
            '',
            '- **blocker** `old.ts:1`: stale problem — stale fix',
            '',
            '## Constraints',
            '',
            'Do not break anything.',
        ].join('\n');

        const result = withFindings(body, [finding({ file: 'new.ts', line: 9 })]);

        expect(result).toContain('## Constraints\n\nDo not break anything.');
        expect(result).toContain('new.ts:9');
        expect(result).not.toContain('old.ts');
    });

    it('removes the section entirely when findings is empty, restoring the body to what preceded it', () => {
        const body = [
            '## Goal',
            '',
            'Do the thing.',
            '',
            '## Review findings',
            '',
            '- **blocker** `old.ts:1`: stale problem — stale fix',
            '',
            '## Constraints',
            '',
            'Do not break anything.',
        ].join('\n');

        const result = withFindings(body, []);

        expect(result).toBe('## Goal\n\nDo the thing.\n\n## Constraints\n\nDo not break anything.');
        expect(result).not.toContain('Review findings');
    });

    it('is a no-op on a body with no findings section and no findings to add', () => {
        const body = '## Goal\n\nDo the thing.';

        expect(withFindings(body, [])).toBe(body);
    });

    it('does not add a leading blank line when the body already ends with one', () => {
        const body = '## Goal\n\nDo the thing.\n';

        const result = withFindings(body, [finding()]);

        expect(result).toBe('## Goal\n\nDo the thing.\n\n## Review findings\n\n- **blocker** `src/thing.ts:12`: the thing is broken — fix the thing');
    });
});
