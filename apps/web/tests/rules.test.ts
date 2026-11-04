// @vitest-environment jsdom
//
// What a card shows of its rule verdicts: the newest `rule.verdicts` event, read by hand off an untyped
// payload, so an event from another version of the API cannot break the page.
import { createElement } from 'react';
import { DateTime } from 'luxon';
import { cleanup, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardEvent } from '@wilson/sdk';
import { RuleVerdictsPanel } from '../src/components/RuleVerdictsPanel.js';
import { latestRuleVerdicts, parseGlobs } from '../src/lib/rules.js';

const event = (type: string, payload: unknown): CardEvent => ({ id: '1', type, payload, createdAt: DateTime.utc() }) as unknown as CardEvent;

const failing = {
    rule: 'no-raw-sql',
    statement: 'Queries go through Kysely',
    verdict: 'fail',
    file: 'src/a.ts',
    line: 3,
    evidence: 'Builds SQL by hand.',
};

describe('latestRuleVerdicts', () => {
    it('takes the newest event, whatever comes after it', () => {
        const verdicts = latestRuleVerdicts([
            event('rule.verdicts', { verdicts: [{ rule: 'old', verdict: 'pass' }] }),
            event('rule.verdicts', { verdicts: [failing] }),
            event('stage.passed', {}),
        ]);

        expect(verdicts).toEqual([failing]);
    });

    it.each([
        ['no events yet', undefined],
        ['no verdicts on the card', [event('stage.passed', {})]],
        ['a payload that is not one', [event('rule.verdicts', { verdicts: 'nope' })]],
        ['an entry that is not one', [event('rule.verdicts', { verdicts: [{ rule: 'x', verdict: 'maybe' }, null] })]],
    ])('is empty for %s', (_name, events) => {
        expect(latestRuleVerdicts(events)).toEqual([]);
    });
});

describe('parseGlobs', () => {
    it('splits on lines and spaces, keeping a comma inside braces', () => {
        expect(parseGlobs(' src/**\n\n{a,b}/*.ts  docs/**\n')).toEqual(['src/**', '{a,b}/*.ts', 'docs/**']);
    });
});

describe('RuleVerdictsPanel', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'matchMedia',
            vi.fn().mockImplementation((query: string) => ({
                matches: false,
                media: query,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            })),
        );
    });
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    const panel = (events: CardEvent[]) => render(createElement(MantineProvider, null, createElement(RuleVerdictsPanel, { events })));

    it('shows nothing for a card no rule matched', () => {
        panel([event('stage.passed', {})]);
        expect(screen.queryByText('Checked rules')).toBeNull();
    });

    it('shows a failure with its citation and evidence, a pass without, and an unavailable with why', () => {
        panel([
            event('rule.verdicts', {
                verdicts: [
                    failing,
                    { rule: 'clean', verdict: 'pass', evidence: 'Not shown.' },
                    { rule: 'big', verdict: 'unavailable', evidence: 'Diff too large.' },
                ],
            }),
        ]);

        expect(screen.getByText('Failed')).toBeTruthy();
        expect(screen.getByText('src/a.ts:3')).toBeTruthy();
        expect(screen.getByText('Builds SQL by hand.')).toBeTruthy();
        expect(screen.getByText('Passed')).toBeTruthy();
        expect(screen.queryByText('Not shown.')).toBeNull();
        expect(screen.getByText('No verdict')).toBeTruthy();
        expect(screen.getByText('Diff too large.')).toBeTruthy();
    });
});
