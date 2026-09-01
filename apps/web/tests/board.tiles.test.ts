// @vitest-environment jsdom
//
// Card 0174: a board tile answers "what state is this card in" at a glance — a leading `StateIcon`
// face, a dependency indicator even when satisfied, a dimmed age-in-stage line, and column headers
// that surface a flagged sub-count. These tests render the real route tree, the same approach
// `board-filter.test.ts` and `flagged.test.ts` take, so the tile markup is exercised as actually
// wired up rather than re-implemented here.
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient } from '@wilson/sdk';
import type { BoardColumns, CardSummary } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

const columns: BoardColumns = {
    stages: ['implementing'],
    nonStages: ['merged'],
};

const card = (
    id: string,
    stage: string,
    opts: { needsHuman?: boolean; dependsOn?: string[]; stageEnteredAt?: string } = {},
): CardSummary => ({
    id,
    title: `card ${id}`,
    stage,
    dependsOn: opts.dependsOn ?? [],
    needsHuman: opts.needsHuman ?? false,
    stageEnteredAt: opts.stageEnteredAt,
});

/** Same stand-in `board-filter.test.ts`/`flagged.test.ts` use for the shared header's board feed. */
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
        createElement(
            MantineProvider,
            null,
            createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
        ),
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

describe('board tile state iconography', () => {
    it('shows the needs-human face on a flagged tile', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'implementing', { needsHuman: true })]);

        renderApp('/projects/demo');

        const title = await screen.findByText('card 0001');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(within(tile).getByRole('img', { name: 'Wilson — needs human' })).toBeTruthy();
    });

    it('shows the parked face for a parking-lot card', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0002', 'parking-lot')]);

        renderApp('/projects/demo');

        const title = await screen.findByText('card 0002');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(within(tile).getByRole('img', { name: 'Wilson — parked' })).toBeTruthy();
    });

    it('shows the passed face for a merged card', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0003', 'merged')]);

        renderApp('/projects/demo');

        const title = await screen.findByText('card 0003');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(within(tile).getByRole('img', { name: 'Wilson — passed' })).toBeTruthy();
    });

    it('renders no state face for a plain in-flight stage', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0004', 'implementing')]);

        renderApp('/projects/demo');

        const title = await screen.findByText('card 0004');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(within(tile).queryByRole('img')).toBeNull();
    });
});

describe('the dependency indicator', () => {
    it('shows a dimmed "n deps" marker and no "blocked on" badge once every dependency has merged', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([
            card('0005', 'merged'),
            card('0006', 'implementing', { dependsOn: ['0005'] }),
        ]);

        renderApp('/projects/demo');

        const title = await screen.findByText('card 0006');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(within(tile).getByText('1 deps')).toBeTruthy();
        expect(within(tile).queryByText(/blocked on/)).toBeNull();
    });

    it('keeps the orange "blocked on" badge, not the deps marker, while a dependency is unfinished', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([
            card('0007', 'implementing'),
            card('0008', 'implementing', { dependsOn: ['0007'] }),
        ]);

        renderApp('/projects/demo');

        const title = await screen.findByText('card 0008');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(within(tile).getByText('blocked on 0007')).toBeTruthy();
        expect(within(tile).queryByText('1 deps')).toBeNull();
    });
});

describe('the age-in-stage line', () => {
    it('renders a relative age line when stageEnteredAt is present', async () => {
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0009', 'implementing', { stageEnteredAt: threeDaysAgo })]);

        renderApp('/projects/demo');

        const title = await screen.findByText('card 0009');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(within(tile).getByText(/^\d+d in stage$/)).toBeTruthy();
    });

    it('renders no age line at all when stageEnteredAt is absent', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0010', 'implementing')]);

        renderApp('/projects/demo');

        const title = await screen.findByText('card 0010');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(within(tile).queryByText(/in stage$/)).toBeNull();
    });
});

describe('column header flagged sub-count', () => {
    it('shows a red flagged sub-count when a card in the column needs a human', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([
            card('0011', 'implementing', { needsHuman: true }),
            card('0012', 'implementing'),
        ]);

        renderApp('/projects/demo');

        const column = await screen.findByTestId('column-implementing');
        expect(within(column).getByText('1 flagged')).toBeTruthy();
        expect(within(column).getByText('2')).toBeTruthy();
    });

    it('shows no flagged sub-count when nothing in the column needs a human', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0013', 'implementing')]);

        renderApp('/projects/demo');

        const column = await screen.findByTestId('column-implementing');
        expect(within(column).queryByText(/flagged/)).toBeNull();
        expect(within(column).getByText('1')).toBeTruthy();
    });
});
