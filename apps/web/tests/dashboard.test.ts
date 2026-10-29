import { DateTime } from 'luxon';
// @vitest-environment jsdom
//
// Card 0169: `/` (`apps/web/src/routes/index.tsx`) is new — before this card, loading the app with no
// URL in mind hit TanStack's own "Not Found" (`project-routes.test.ts` used to assert exactly that,
// and now asserts the dashboard instead). This is the one thing that page actually adds: the
// registered projects, by name, each a link to its own board. These tests render the real route
// tree, the same approach `project-switcher.test.ts` and `project-routes.test.ts` take, so the new
// route, its `AnchorLink` navigation, its loading/error states, and the header's new home link
// (`__root.tsx`) are all exercised as actually wired up — not re-implemented here.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, ChatClient, HealthClient, ProjectsClient } from '@wilson/sdk';
import type { BoardColumns, Health } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

const emptyColumns: BoardColumns = { stages: ['planning'], nonStages: [] };

const baseHealth: Health = {
    ok: true,
    project: 'demo',
    head: 'abc1234',
    startedAt: DateTime.fromISO('2026-01-01T00:00:00.000Z'),
    codeRoot: '/deploy/code',
    worktreeRoot: '/deploy/worktrees',
};

/** `Board` renders inside Mantine's `ScrollArea`, which measures itself with `ResizeObserver` on
 * mount — jsdom does not implement it, and clicking a dashboard link lands on a project's board. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

class FakeEventSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
}

const stubProjectsEndpoint = (names: string[]) => vi.spyOn(ProjectsClient.prototype, 'listProjects').mockResolvedValue(names.map(name => ({ name })));

function renderApp(path: string) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    // Matches `project-routes.test.ts`'s own `renderApp`: without `retry: false`, a rejected
    // `listRegisteredProjects` call retries several times before `useQuery` ever surfaces the error,
    // which would make the "Cannot reach the API" test below wait through real backoff delays.
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
    vi.spyOn(HealthClient.prototype, 'getHealth').mockResolvedValue(baseHealth);
    vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([]);
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
    // The chat home's composer is an autosizing `Textarea`, which listens on `document.fonts`.
    Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener: vi.fn(), removeEventListener: vi.fn() } });
});

afterEach(() => {
    // `apps/web/vitest.config.ts` does not set `test.globals: true`, so `@testing-library/react`'s
    // own auto-cleanup never registers — without this, each test's `render()` piles onto the
    // previous test's DOM instead of replacing it.
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the dashboard at /projects', () => {
    it('lists every registered project GET /api/projects returns, by name, each linked to its own board', async () => {
        stubProjectsEndpoint(['demo', 'other']);

        renderApp('/projects');

        const demo = (await screen.findByRole('link', { name: 'demo' })) as HTMLAnchorElement;
        const other = (await screen.findByRole('link', { name: 'other' })) as HTMLAnchorElement;
        expect(demo.getAttribute('href')).toBe('/projects/demo');
        expect(other.getAttribute('href')).toBe('/projects/other');
    });

    it('navigates to a project\'s own board on click, rendering that project\'s board rather than a link that merely looks right', async () => {
        stubProjectsEndpoint(['demo']);
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(emptyColumns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([]);

        const { router } = renderApp('/projects');

        fireEvent.click(await screen.findByRole('link', { name: 'demo' }));

        await waitFor(() => expect(router.state.location.pathname).toBe('/projects/demo'));
        expect(await screen.findByText('0 cards')).toBeTruthy();
    });

    it('renders a loader while the registered-projects request is in flight, not an empty panel', async () => {
        let resolveProjects: (projects: { name: string }[]) => void = () => {};
        vi.spyOn(ProjectsClient.prototype, 'listProjects').mockReturnValue(
            new Promise(resolve => {
                resolveProjects = resolve;
            }),
        );

        renderApp('/projects');

        const panel = await screen.findByText('Projects');
        await waitFor(() => expect(panel.closest('.mantine-Paper-root')?.querySelector('.mantine-Loader-root')).not.toBeNull());

        await act(async () => {
            resolveProjects([{ name: 'demo' }]);
        });

        expect(await screen.findByRole('link', { name: 'demo' })).toBeTruthy();
        expect(panel.closest('.mantine-Paper-root')?.querySelector('.mantine-Loader-root')).toBeNull();
    });

    it('shows an alert titled "Cannot reach the API" when the registered-projects request fails, rather than a crash or an empty page', async () => {
        vi.spyOn(ProjectsClient.prototype, 'listProjects').mockRejectedValue(new Error('502 Bad Gateway'));

        renderApp('/projects');

        expect(await screen.findByText('Cannot reach the API')).toBeTruthy();
        expect(await screen.findByText('502 Bad Gateway')).toBeTruthy();
        expect(screen.queryByRole('link', { name: /demo|other/ })).toBeNull();
    });

    // This card's own constraint: the dashboard reuses `ProjectSwitcher`'s query key,
    // `['registered-projects']`, specifically so both consumers share one cache entry instead of
    // firing their own independent requests. With two projects registered, both the dashboard's list
    // and the header's switcher are on screen at once at `/` — proving there's still only one call is
    // the only way to tell a shared cache entry from two that merely happen to agree.
    it('shares the registered-projects cache with the header\'s ProjectSwitcher instead of fetching twice', async () => {
        const listProjects = stubProjectsEndpoint(['demo', 'other']);

        renderApp('/projects');

        await screen.findByRole('link', { name: 'demo' });
        fireEvent.click(await screen.findByLabelText('Switch project'));
        const items = await screen.findAllByRole('menuitem');
        expect(items.map(item => item.textContent)).toEqual(['demo', 'other']);

        expect(listProjects).toHaveBeenCalledTimes(1);
    });

    it('does not display any of the four filesystem paths GET /api/projects withholds', async () => {
        stubProjectsEndpoint(['demo']);

        renderApp('/projects');

        await screen.findByRole('link', { name: 'demo' });
        for (const path of ['/deploy/board', '/deploy/code', '/deploy/worktrees']) {
            expect(screen.queryByText(path)).toBeNull();
        }
    });
});

describe('the header title', () => {
    // `/` is the chat now, the whole page (`routes/index.tsx`); the title still leads there.
    it('links to / from a project-scoped route, not just from the dashboard itself', async () => {
        stubProjectsEndpoint(['demo']);
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(emptyColumns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([]);

        const { router } = renderApp('/projects/demo');
        await screen.findByText('0 cards');

        const title = await screen.findByText('wilson');
        const homeLink = title.closest('a');
        expect(homeLink?.getAttribute('href')).toBe('/');

        fireEvent.click(homeLink!);

        await waitFor(() => expect(router.state.location.pathname).toBe('/'));
        expect(await screen.findByText('What should we do?')).toBeTruthy();
    });

    it('sits beside a Projects link to the dashboard, one click from anywhere', async () => {
        stubProjectsEndpoint(['demo']);
        const { router } = renderApp('/');

        fireEvent.click(await screen.findByLabelText('Projects'));

        await waitFor(() => expect(router.state.location.pathname).toBe('/projects'));
        expect(await screen.findByRole('link', { name: 'demo' })).toBeTruthy();
    });
});
