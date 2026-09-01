// @vitest-environment jsdom
//
// Card 0183: every board column can collapse to a narrow rail and back, remembered per project in
// `localStorage` (`collapsedColumnsKey`, `lib/board.ts`) across reloads. These tests render the real
// route tree, the same approach `board-filter.test.ts` takes, so the collapse control and its
// persistence are exercised as actually wired up in `Board.tsx` rather than re-implemented here.
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

const card = (id: string, stage: string, needsHuman = false): CardSummary => ({
    id,
    title: `card ${id}`,
    stage,
    dependsOn: [],
    needsHuman,
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

/**
 * A `Storage`-shaped in-memory stand-in for `localStorage`, stubbed in for the same reason this
 * file already stubs `EventSource`/`ResizeObserver`/`matchMedia`: under this repo's pinned Node
 * (>=22), `globalThis.localStorage` is Node's own built-in accessor, already present before jsdom's
 * environment sets up — `window === globalThis` here, so jsdom's own `window.localStorage` never
 * gets a chance to shadow it (vitest's global population skips any key that already exists on
 * `globalThis`). Node's accessor logs an `ExperimentalWarning` and yields `undefined` without
 * `--localstorage-file`, so `@mantine/hooks`' `useLocalStorage` silently falls back to in-memory-only
 * state — real within one render tree, but gone on the next `renderApp`, which is exactly what
 * these tests are asserting survives. A real browser's `localStorage` needs none of this.
 */
class MemoryStorage {
    private readonly store = new Map<string, string>();
    getItem(key: string): string | null {
        return this.store.has(key) ? this.store.get(key)! : null;
    }
    setItem(key: string, value: string): void {
        this.store.set(key, value);
    }
    removeItem(key: string): void {
        this.store.delete(key);
    }
    clear(): void {
        this.store.clear();
    }
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
    vi.stubGlobal('localStorage', new MemoryStorage());
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
    // Card 0183: collapse state is `localStorage`, which outlives `cleanup()` — without clearing it,
    // the first test's collapse leaks into every test after it. Cleared while the stub above is
    // still installed, before `vi.unstubAllGlobals()` below removes it.
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('collapsing a board column', () => {
    it('removes the column\'s card tiles from the DOM while the column and its stage name stay rendered', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'merged')]);

        renderApp('/projects/demo');

        await screen.findByText('card 0001');
        fireEvent.click(screen.getByLabelText('Collapse merged column'));

        const column = screen.getByTestId('column-merged');
        expect(within(column).queryByText('card 0001')).toBeNull();
        expect(within(column).getByText('merged')).toBeTruthy();
    });

    it('still shows the card count and, with a flagged card, the "n flagged" badge on the collapsed rail', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue({
            stages: ['implementing'],
            nonStages: ['merged'],
        });
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'merged', true), card('0002', 'merged')]);

        renderApp('/projects/demo');

        await screen.findByText('card 0001');
        fireEvent.click(screen.getByLabelText('Collapse merged column'));

        const column = screen.getByTestId('column-merged');
        expect(within(column).getByText('2')).toBeTruthy();
        expect(within(column).getByText('1 flagged')).toBeTruthy();
    });

    it('brings the tiles back when the rail is clicked to expand', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'merged')]);

        renderApp('/projects/demo');

        await screen.findByText('card 0001');
        fireEvent.click(screen.getByLabelText('Collapse merged column'));
        expect(screen.queryByText('card 0001')).toBeNull();

        fireEvent.click(screen.getByLabelText('Expand merged column'));
        expect(await screen.findByText('card 0001')).toBeTruthy();
    });

    it('leaves the other columns alone — collapsing merged does not hide an implementing tile', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'implementing'), card('0002', 'merged')]);

        renderApp('/projects/demo');

        await screen.findByText('card 0001');
        fireEvent.click(screen.getByLabelText('Collapse merged column'));

        expect(screen.getByText('card 0001')).toBeTruthy();
    });

    it('survives a remount — the same project reopens with the column still collapsed', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'merged')]);

        renderApp('/projects/demo');
        await screen.findByText('card 0001');
        fireEvent.click(screen.getByLabelText('Collapse merged column'));
        expect(screen.queryByText('card 0001')).toBeNull();

        cleanup();
        renderApp('/projects/demo');

        // The board's data arrives asynchronously on this second mount, so a `findBy*` — not a
        // synchronous `queryBy*` — is what actually proves the tile stayed absent rather than just
        // not having loaded yet.
        expect(await screen.findByTestId('column-merged')).toBeTruthy();
        expect(screen.queryByText('card 0001')).toBeNull();
    });

    it('keeps each project\'s collapsed set independent', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'merged')]);

        renderApp('/projects/demo');
        await screen.findByText('card 0001');
        fireEvent.click(screen.getByLabelText('Collapse merged column'));
        expect(screen.queryByText('card 0001')).toBeNull();

        cleanup();
        renderApp('/projects/other');

        expect(await screen.findByText('card 0001')).toBeTruthy();
    });
});
