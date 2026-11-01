import { DateTime } from 'luxon';
// @vitest-environment jsdom
//
// Card 0172: the color-scheme toggle (`ColorSchemeToggle`, `__root.tsx`) is new — an `ActionIcon` in
// the header, on every route, that flips `data-mantine-color-scheme` on `<html>` between light and
// dark. Renders the real route tree, the same approach `flagged.test.ts` and `project-switcher.test.ts`
// take, so the header wiring is exercised as actually built.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead.
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, HealthClient } from '@wilson/sdk';
import type { BoardColumns, Health } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';
import { wilson } from '#src/lib/sdk.js';

const emptyColumns: BoardColumns = { stages: ['planning'], nonStages: [] };

const baseHealth: Health = {
    ok: true,
    project: 'demo',
    head: 'abc1234',
    startedAt: DateTime.fromISO('2026-01-01T00:00:00.000Z'),
    codeRoot: '/deploy/code',
    worktreeRoot: '/deploy/worktrees',
};

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
    const queryClient = new QueryClient();
    render(
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
    return { router };
}

beforeEach(() => {
    vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(emptyColumns);
    vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([]);
    vi.spyOn(HealthClient.prototype, 'getHealth').mockResolvedValue(baseHealth);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // jsdom does not implement matchMedia; MantineProvider reads it (colour-scheme detection) on
    // mount, and stubbing it "not dark" is what makes the initial computed scheme "light" below.
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
    document.documentElement.removeAttribute('data-mantine-color-scheme');
});

describe('the color-scheme toggle in the header', () => {
    it('flips data-mantine-color-scheme on <html> from light to dark and back', async () => {
        renderApp('/projects/demo');
        await screen.findByText('0 cards');

        expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('light');

        const toggle = screen.getByLabelText('Toggle color scheme');
        fireEvent.click(toggle);
        expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('dark');

        fireEvent.click(toggle);
        expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('light');
    });

    it('is reachable from every route, not just the board', async () => {
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });

        renderApp('/settings');
        await screen.findByRole('heading', { name: 'Settings' });

        const toggle = screen.getByLabelText('Toggle color scheme');
        fireEvent.click(toggle);

        expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('dark');
    });
});
