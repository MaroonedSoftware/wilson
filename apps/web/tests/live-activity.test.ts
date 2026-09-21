// @vitest-environment jsdom
//
// Card 0274: `LiveActivity` (`apps/web/src/components/LiveActivity.tsx`) is new — the card page's
// live tool-call list (AC6). Mounted directly here, wrapped in `CardActivityContext.Provider`
// (`lib/feed.ts`), rather than through the full route tree: this is a presentational component over
// `seedEvents` (a prop) and `toolLog`/`now` (context), so exercising it directly is both faster and
// more precise about what it renders for a given input. Neither the component, the context nor
// `MAX_LIVE_TOOL_EVENTS` exist on the pre-change tree — every test below fails to even import there.
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardEvent } from '@wilson/sdk';
import { CardActivityContext, MAX_LIVE_TOOL_EVENTS, type FeedToolEvent } from '#src/lib/feed.js';
import { LiveActivity } from '#src/components/LiveActivity.js';

/** `LiveActivity`'s rows sit inside a Mantine `ScrollArea`, which measures itself with
 * `ResizeObserver` on mount — jsdom does not implement it. Same stand-in `board.tiles.test.ts` uses. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

// `MantineProvider` reads `matchMedia` on mount (colour-scheme detection) regardless of what this
// file renders — jsdom does not implement it. Same stand-in `flagged.test.ts`/`settings.test.ts` use.
beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
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

const NOW = new Date('2026-01-10T12:00:00.000Z');

function renderLiveActivity({
    cardId = '0043',
    seedEvents,
    toolLog = {},
    now = NOW,
}: {
    cardId?: string;
    seedEvents: CardEvent[] | undefined;
    toolLog?: Record<string, FeedToolEvent[]>;
    now?: Date;
}) {
    return render(
        createElement(
            MantineProvider,
            null,
            createElement(
                CardActivityContext.Provider,
                { value: { activity: {}, toolLog, now } },
                createElement(LiveActivity, { cardId, seedEvents }),
            ),
        ),
    );
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const cardEvent = (overrides: Partial<CardEvent> = {}): CardEvent => ({
    id: 'ev-1',
    type: 'tool.executed',
    stage: 'implementing',
    payload: { tool: 'bash', command: 'pnpm test' },
    createdAt: '2026-01-10T11:59:00.000Z',
    ...overrides,
});

const toolEvent = (overrides: Partial<FeedToolEvent> = {}): FeedToolEvent => ({
    id: 1,
    type: 'tool.executed',
    payload: { tool: 'bash', command: 'pnpm test' },
    ts: '2026-01-10T11:59:30.000Z',
    ...overrides,
});

describe('LiveActivity empty state', () => {
    it('shows "No tool calls yet." when there is neither a seed nor a live event', () => {
        renderLiveActivity({ seedEvents: [] });
        expect(screen.getByText('No tool calls yet.')).toBeTruthy();
    });

    it('shows "No tool calls yet." while seedEvents is still undefined (the events query hasn\'t resolved)', () => {
        renderLiveActivity({ seedEvents: undefined });
        expect(screen.getByText('No tool calls yet.')).toBeTruthy();
    });

    it('ignores a non-tool event in the seed tail — it is not part of the tool-call list', () => {
        renderLiveActivity({ seedEvents: [cardEvent({ type: 'stage.dispatched', payload: null })] });
        expect(screen.getByText('No tool calls yet.')).toBeTruthy();
    });
});

describe('LiveActivity seeding (AC6)', () => {
    it('seeds rows from the fetched events tail, so a page opened mid-run is not empty', () => {
        renderLiveActivity({ seedEvents: [cardEvent({ id: 'ev-1', payload: { tool: 'bash', command: 'ls' } })] });

        expect(screen.getByText('ls')).toBeTruthy();
        expect(screen.getByText('bash')).toBeTruthy();
    });

    it('shows a live tool event even when there is no seed at all', () => {
        renderLiveActivity({ seedEvents: [], toolLog: { '0043': [toolEvent({ payload: { tool: 'write', path: 'src/a.ts' } })] } });

        expect(screen.getByText('src/a.ts')).toBeTruthy();
        expect(screen.getByText('write')).toBeTruthy();
    });

    it('reads only this card\'s own tool log, not another card\'s', () => {
        renderLiveActivity({
            cardId: '0043',
            seedEvents: [],
            toolLog: { '0099': [toolEvent({ payload: { tool: 'bash', command: 'belongs to 0099' } })] },
        });

        expect(screen.getByText('No tool calls yet.')).toBeTruthy();
    });
});

describe('LiveActivity ordering', () => {
    it('lists a live event ahead of the (older) seeded tail', () => {
        renderLiveActivity({
            seedEvents: [cardEvent({ id: 'ev-1', createdAt: '2026-01-10T11:00:00.000Z', payload: { tool: 'bash', command: 'first command' } })],
            toolLog: {
                '0043': [toolEvent({ id: 1, ts: '2026-01-10T11:59:30.000Z', payload: { tool: 'bash', command: 'newest command' } })],
            },
        });

        const rows = screen.getAllByText(/command$/);
        expect(rows[0].textContent).toBe('newest command');
        expect(rows[1].textContent).toBe('first command');
    });
});

describe('LiveActivity row labels', () => {
    it('shows the command for a shell call', () => {
        renderLiveActivity({ seedEvents: [], toolLog: { '0043': [toolEvent({ payload: { tool: 'bash', command: 'pnpm build' } })] } });
        expect(screen.getByText('pnpm build')).toBeTruthy();
    });

    it('shows the path for a file tool', () => {
        renderLiveActivity({ seedEvents: [], toolLog: { '0043': [toolEvent({ payload: { tool: 'edit', path: 'apps/web/src/a.ts' } })] } });
        expect(screen.getByText('apps/web/src/a.ts')).toBeTruthy();
    });

    it('shows the reason for a denial, not the command it denied', () => {
        renderLiveActivity({
            seedEvents: [],
            toolLog: { '0043': [toolEvent({ type: 'tool.denied', payload: { tool: 'bash', command: 'rm -rf /', reason: 'not in the allowlist' } })] },
        });

        expect(screen.getByText('not in the allowlist')).toBeTruthy();
        expect(screen.queryByText('rm -rf /')).toBeNull();
    });

    it('shows the relative time off the shared clock passed through context', () => {
        renderLiveActivity({
            seedEvents: [],
            toolLog: { '0043': [toolEvent({ ts: '2026-01-10T11:59:00.000Z' })] },
            now: new Date('2026-01-10T12:00:00.000Z'),
        });

        expect(screen.getByText('1m ago')).toBeTruthy();
    });
});

describe('LiveActivity dedupe', () => {
    it('drops a live event that exactly matches the newest seed event\'s own (type, ts), rather than showing it twice', () => {
        renderLiveActivity({
            seedEvents: [
                cardEvent({ id: 'ev-1', type: 'tool.executed', createdAt: '2026-01-10T11:59:00.000Z', payload: { tool: 'bash', command: 'same command' } }),
            ],
            toolLog: {
                '0043': [
                    toolEvent({ id: 99, type: 'tool.executed', ts: '2026-01-10T11:59:00.000Z', payload: { tool: 'bash', command: 'same command' } }),
                ],
            },
        });

        expect(screen.getAllByText('same command')).toHaveLength(1);
    });

    it('keeps a live event that differs from the newest seed only by ts, rather than dropping it as a false match', () => {
        renderLiveActivity({
            seedEvents: [
                cardEvent({ id: 'ev-1', type: 'tool.executed', createdAt: '2026-01-10T11:59:00.000Z', payload: { tool: 'bash', command: 'repeated command' } }),
            ],
            toolLog: {
                '0043': [
                    toolEvent({ id: 99, type: 'tool.executed', ts: '2026-01-10T11:59:59.000Z', payload: { tool: 'bash', command: 'repeated command' } }),
                ],
            },
        });

        expect(screen.getAllByText('repeated command')).toHaveLength(2);
    });
});

describe('LiveActivity cap', () => {
    it(`caps the list at ${MAX_LIVE_TOOL_EVENTS} and shows a "more may exist" note past the cap`, () => {
        const seedEvents = Array.from({ length: MAX_LIVE_TOOL_EVENTS + 10 }, (_, i) =>
            cardEvent({
                id: `ev-${i}`,
                createdAt: `2026-01-10T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
                payload: { tool: 'bash', command: `command ${i}` },
            }),
        );

        renderLiveActivity({ seedEvents });

        expect(screen.getByText(new RegExp(`most recent ${MAX_LIVE_TOOL_EVENTS} tool calls`))).toBeTruthy();
    });

    it('does not show the "more may exist" note when under the cap', () => {
        renderLiveActivity({ seedEvents: [cardEvent()] });
        expect(screen.queryByText(/more may exist/)).toBeNull();
    });
});
