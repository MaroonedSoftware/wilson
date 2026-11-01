// @vitest-environment jsdom
//
// Card 0175: a cold load renders a skeleton board (`BoardSkeleton`, `data-testid="board-skeleton"`)
// instead of a bare `Loader` on both the board route and `/flagged`, and the board toolbar gets a
// client-side text filter (`BoardFilter`) over `card.id`/`card.title` with an "n of m cards" count.
// These tests render the real route tree, the same approach `project-routes.test.ts` and
// `flagged.test.ts` take, so the filter and the skeleton swap are exercised as actually wired up.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient } from '@wilson/sdk';
import type { BoardColumns, CardSummary } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

const columns: BoardColumns = {
    stages: ['planning', 'implementing', 'review'],
    nonStages: ['needs-human'],
};

const card = (id: string, title: string, stage = 'planning'): CardSummary => ({
    id,
    title,
    stage,
    dependsOn: [],
    needsHuman: false,
});

const cards: CardSummary[] = [card('0001', 'fix the parser'), card('0002', 'update docs'), card('0003', 'parser follow-up')];

/** Same stand-in `project-routes.test.ts`/`flagged.test.ts` use for the shared header's board feed. */
class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

/** `Board` renders inside Mantine's `ScrollArea`, which measures itself with `ResizeObserver` on
 * mount — jsdom does not implement it. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function renderApp(path: string) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
    return { router };
}

beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
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
    vi.stubGlobal('scrollTo', vi.fn());
});

afterEach(() => {
    // `apps/web/vitest.config.ts` does not set `test.globals: true`, so `@testing-library/react`'s
    // own auto-cleanup never registers — without this, each test's `render()` piles onto the
    // previous test's DOM instead of replacing it.
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the board toolbar text filter', () => {
    beforeEach(() => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue(cards);
    });

    it('hides non-matching tiles and keeps matching ones on a title substring, case-insensitively', async () => {
        renderApp('/projects/demo');

        await screen.findByText('fix the parser');
        const input = screen.getByLabelText('Filter cards by id or title');

        fireEvent.change(input, { target: { value: 'PARSER' } });

        expect(await screen.findByText('fix the parser')).toBeTruthy();
        expect(await screen.findByText('parser follow-up')).toBeTruthy();
        expect(screen.queryByText('update docs')).toBeNull();
    });

    it('matches on an id substring too, leaving only that tile rendered', async () => {
        renderApp('/projects/demo');

        await screen.findByText('fix the parser');
        const input = screen.getByLabelText('Filter cards by id or title');

        fireEvent.change(input, { target: { value: '0002' } });

        expect(await screen.findByText('update docs')).toBeTruthy();
        expect(screen.queryByText('fix the parser')).toBeNull();
        expect(screen.queryByText('parser follow-up')).toBeNull();
    });

    it('shows an "n of m cards" count while filtered, and restores the plain count once cleared', async () => {
        renderApp('/projects/demo');

        await screen.findByText('fix the parser');
        expect(await screen.findByText('3 cards')).toBeTruthy();

        const input = screen.getByLabelText('Filter cards by id or title');
        fireEvent.change(input, { target: { value: 'parser' } });

        expect(await screen.findByText('2 of 3 cards')).toBeTruthy();
        expect(screen.queryByText('3 cards')).toBeNull();

        fireEvent.click(screen.getByLabelText('Clear filter'));

        expect(await screen.findByText('3 cards')).toBeTruthy();
        expect(await screen.findByText('update docs')).toBeTruthy();
    });
});

describe('the board skeleton on a cold load', () => {
    it('renders on the board route while columns and cards are still in flight', async () => {
        let resolveCards: (cards: CardSummary[]) => void = () => {};
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockReturnValue(
            new Promise(resolve => {
                resolveCards = resolve;
            }),
        );

        renderApp('/projects/demo');

        expect(await screen.findByTestId('board-skeleton')).toBeTruthy();

        await act(async () => {
            resolveCards(cards);
        });

        expect(await screen.findByText('fix the parser')).toBeTruthy();
        expect(screen.queryByTestId('board-skeleton')).toBeNull();
    });

    it('renders on the /flagged route while columns and cards are still in flight', async () => {
        let resolveCards: (cards: CardSummary[]) => void = () => {};
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockReturnValue(
            new Promise(resolve => {
                resolveCards = resolve;
            }),
        );

        renderApp('/projects/demo/flagged');

        expect(await screen.findByTestId('board-skeleton')).toBeTruthy();

        await act(async () => {
            resolveCards(cards);
        });

        expect(await screen.findByText('Cards needing a human')).toBeTruthy();
        expect(screen.queryByTestId('board-skeleton')).toBeNull();
    });
});
