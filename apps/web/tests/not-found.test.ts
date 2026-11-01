// @vitest-environment jsdom
//
// Card 0173: `NotFound` (`apps/web/src/components/NotFound.tsx`) is new — before this card, an
// unmatched URL fell through to TanStack Router's own built-in "Not Found", with no way back and
// none of this app's own chrome. This renders the real route tree with the same
// `defaultNotFoundComponent` wiring `main.tsx` uses (not `routeTree.gen.ts`'s own default router
// options — that wiring lives on the `createRouter` call, so a test has to set it up the same way to
// actually exercise it), so an unknown path is what's asserted, not `NotFound` rendered in isolation.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead.
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsClient } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';
import { NotFound } from '#src/components/NotFound.js';

class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

function renderApp(path: string) {
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [path] }),
        defaultNotFoundComponent: NotFound,
    });
    const queryClient = new QueryClient();
    render(
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
    return { router };
}

beforeEach(() => {
    vi.spyOn(ProjectsClient.prototype, 'listProjects').mockResolvedValue([{ name: 'demo' }]);
    vi.stubGlobal('EventSource', FakeEventSource);
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

describe('an unmatched URL', () => {
    it("renders the not-found screen instead of TanStack Router's own built-in fallback", async () => {
        renderApp('/this/path/does/not/exist');

        expect(await screen.findByText('Page not found')).toBeTruthy();
    });

    it('links back to the dashboard at /projects', async () => {
        renderApp('/this/path/does/not/exist');

        const home = (await screen.findByRole('link', { name: 'Back to the dashboard' })) as HTMLAnchorElement;
        expect(home.getAttribute('href')).toBe('/projects');
    });

    it('actually navigates home on click, not just a link that looks right', async () => {
        const { router } = renderApp('/this/path/does/not/exist');

        fireEvent.click(await screen.findByRole('link', { name: 'Back to the dashboard' }));

        await waitFor(() => expect(router.state.location.pathname).toBe('/projects'));
        expect(await screen.findByRole('link', { name: 'demo' })).toBeTruthy();
    });
});
