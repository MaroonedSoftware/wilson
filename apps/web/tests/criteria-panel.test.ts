import { DateTime } from 'luxon';
// @vitest-environment jsdom
//
// Card 0245. `CriteriaPanel` lists a plan's acceptance criteria with the status the latest review
// gave each one. It reads that status from the most recent `stage.passed`/`stage.failed` event whose
// `stage` is `'review'`, narrowing its `payload.result.criteria` array by hand (`CardEvent.payload`
// carries no per-`type` union). None of this existed before this card: this file renders the
// component directly (no router needed — it takes `criteria`/`events` as plain props) and asserts on
// what actually reaches the screen.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead.
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardEvent } from '@wilson/sdk';
import { CriteriaPanel } from '#src/components/CriteriaPanel.js';

const CRITERIA = [
    { id: 'AC1', text: 'Widget renders.' },
    { id: 'AC2', text: 'Widget updates.' },
];

/** A `stage.passed`/`stage.failed` event carrying a review's own `criteria` array, the shape `ReviewResultSchema` gives it. */
const reviewEvent = (
    type: 'stage.passed' | 'stage.failed',
    criteria: { id: string; status: string }[],
    overrides: Partial<CardEvent> = {},
): CardEvent => ({
    id: 'e1',
    type,
    stage: 'review',
    payload: { result: { criteria } },
    createdAt: DateTime.fromISO('2026-01-01T00:00:00.000Z'),
    ...overrides,
});

function renderPanel(criteria: { id: string; text: string }[], events: CardEvent[] | undefined) {
    render(createElement(MantineProvider, null, createElement(CriteriaPanel, { criteria, events })));
}

beforeEach(() => {
    // jsdom does not implement matchMedia; MantineProvider reads it (colour-scheme detection) on
    // mount regardless of what this test renders. Same stand-in card-detail.actions.test.ts uses.
    vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('CriteriaPanel', () => {
    it('lists every criterion by its ID and text', () => {
        renderPanel(CRITERIA, undefined);

        expect(screen.getByText('AC1')).toBeTruthy();
        expect(screen.getByText('Widget renders.')).toBeTruthy();
        expect(screen.getByText('AC2')).toBeTruthy();
        expect(screen.getByText('Widget updates.')).toBeTruthy();
    });

    it('shows no status badge for any criterion when there has been no review yet', () => {
        renderPanel(CRITERIA, []);

        expect(screen.queryByText('met')).toBeNull();
        expect(screen.queryByText('unmet')).toBeNull();
        expect(screen.queryByText('unverifiable')).toBeNull();
    });

    it('shows no status badge when events exist but none is a review stage result', () => {
        const events: CardEvent[] = [
            { id: 'e0', type: 'stage.passed', stage: 'implementing', payload: {}, createdAt: DateTime.fromISO('2026-01-01T00:00:00.000Z') },
        ];
        renderPanel(CRITERIA, events);

        expect(screen.queryByText('met')).toBeNull();
    });

    it("labels each criterion with the latest review's own status for that ID", () => {
        const events = [
            reviewEvent('stage.passed', [
                { id: 'AC1', status: 'met' },
                { id: 'AC2', status: 'unverifiable' },
            ]),
        ];
        renderPanel(CRITERIA, events);

        expect(screen.getByText('met')).toBeTruthy();
        expect(screen.getByText('unverifiable')).toBeTruthy();
        expect(screen.queryByText('unmet')).toBeNull();
    });

    it('reads the most recent review event, not an earlier one, when several reviews have run', () => {
        const events = [
            reviewEvent('stage.failed', [{ id: 'AC1', status: 'unmet' }], { id: 'e1', createdAt: DateTime.fromISO('2026-01-01T00:00:00.000Z') }),
            reviewEvent('stage.passed', [{ id: 'AC1', status: 'met' }], { id: 'e2', createdAt: DateTime.fromISO('2026-01-02T00:00:00.000Z') }),
        ];
        renderPanel([CRITERIA[0]!], events);

        expect(screen.getByText('met')).toBeTruthy();
        expect(screen.queryByText('unmet')).toBeNull();
    });

    it('ignores a payload whose criteria array is missing or malformed, showing criteria with no badge rather than throwing', () => {
        const events: CardEvent[] = [
            { id: 'e1', type: 'stage.passed', stage: 'review', payload: { result: {} }, createdAt: DateTime.fromISO('2026-01-01T00:00:00.000Z') },
        ];

        expect(() => renderPanel(CRITERIA, events)).not.toThrow();
        expect(screen.getByText('AC1')).toBeTruthy();
        expect(screen.queryByText('met')).toBeNull();
    });
});
