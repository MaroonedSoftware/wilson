// @vitest-environment jsdom
//
// Card 0173: the header's refresh `ActionIcon` (`__root.tsx`, beside the live/snapshot badge) is
// new — before this card the snapshot tooltip read "Not connected — use refresh" with nothing on
// screen that actually did that. Renders the real route tree, the same approach
// `color-scheme-toggle.test.ts` and `project-switcher.test.ts` take, so the header wiring and
// `useCardFeed`'s `reconnect` (`lib/feed.ts`) are exercised as actually built.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, HealthClient } from '@wilson/sdk';
import type { BoardColumns, Health } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

const emptyColumns: BoardColumns = { stages: ['planning'], nonStages: [] };

const baseHealth: Health = {
    ok: true,
    project: 'demo',
    head: 'abc1234',
    startedAt: '2026-01-01T00:00:00.000Z',
    codeRoot: '/deploy/code',
    worktreeRoot: '/deploy/worktrees',
};

/** Same stand-in `feed.test.ts` uses, recording every instance so a test can tell the connection
 * `reconnect` closed apart from the one it opened in its place. */
class FakeEventSource {
    static instances: FakeEventSource[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {
        this.closed = true;
    }

    constructor() {
        FakeEventSource.instances.push(this);
    }
}

/** `Board` renders inside Mantine's `ScrollArea`, which measures itself with `ResizeObserver` on
 * mount — jsdom does not implement it. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function renderApp(path: string, queryClient: QueryClient) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
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
    FakeEventSource.instances = [];
    vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(emptyColumns);
    vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([]);
    vi.spyOn(HealthClient.prototype, 'getHealth').mockResolvedValue(baseHealth);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // jsdom does not implement matchMedia; MantineProvider reads it (colour-scheme detection) on
    // mount regardless of what this test renders.
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
    // TanStack Router's scroll restoration calls this on navigation; jsdom does not implement it.
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

describe('the header refresh affordance', () => {
    it('is reachable beside the live/snapshot badge on every route', async () => {
        const queryClient = new QueryClient();
        renderApp('/projects/demo', queryClient);
        await screen.findByText('0 cards');

        expect(screen.getByLabelText('Refresh')).toBeTruthy();
    });

    it('invalidates every query on click', async () => {
        const queryClient = new QueryClient();
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
        renderApp('/projects/demo', queryClient);
        await screen.findByText('0 cards');

        await act(async () => {
            fireEvent.click(screen.getByLabelText('Refresh'));
        });

        expect(invalidateQueries).toHaveBeenCalledWith();
    });

    it('tears down the current feed connection and opens a fresh one', async () => {
        const queryClient = new QueryClient();
        renderApp('/projects/demo', queryClient);
        await screen.findByText('0 cards');
        const [initial] = FakeEventSource.instances;

        await act(async () => {
            fireEvent.click(screen.getByLabelText('Refresh'));
        });

        expect(initial.closed).toBe(true);
        expect(FakeEventSource.instances).toHaveLength(2);
    });
});
