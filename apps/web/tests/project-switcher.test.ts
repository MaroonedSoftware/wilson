// @vitest-environment jsdom
//
// Card 0154: `ProjectSwitcher` (`apps/web/src/components/ProjectSwitcher.tsx`) is new — the one thing
// this card actually adds that lets a person reach another registered project's URL without typing
// it. It is mounted in the shared header (`__root.tsx`) beside `FlaggedIndicator`, on every route.
// These tests render the real route tree, the same way `flagged.test.ts` and `project-routes.test.ts`
// do, so the header wiring, the `GET /api/projects` request (`lib/projects.ts`) and the navigation on
// pick are all exercised as actually built — not re-implemented here.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead.
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, HealthClient, ProjectsClient } from '@wilson/sdk';
import type { BoardColumns, Health } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

const emptyColumns: BoardColumns = { stages: ['planning'], nonStages: [] };

/** `health.project` is what a route with no `project` param of its own (e.g. `/`) falls back to,
 * the same way `ProjectSwitcher.tsx`'s own doc comment says `FlaggedIndicator` already does. */
const baseHealth: Health = {
    ok: true,
    project: 'demo',
    head: 'abc1234',
    startedAt: '2026-01-01T00:00:00.000Z',
    boardRoot: '/deploy/board',
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
 * mount — jsdom does not implement it, and every test here renders a project's board. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

/**
 * Stubs the generated `ProjectsClient` that `ProjectSwitcher` reads through `listRegisteredProjects`
 * (`lib/projects.ts`) — every request in these tests goes through a mocked SDK client prototype
 * (`BoardClient`/`HealthClient`/`ProjectsClient`), never real `fetch`.
 */
const stubProjectsEndpoint = (names: string[]) => vi.spyOn(ProjectsClient.prototype, 'listProjects').mockResolvedValue(names.map(name => ({ name })));

function renderApp(path: string) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    const queryClient = new QueryClient();
    render(
        createElement(
            MantineProvider,
            null,
            createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
        ),
    );
    return { router };
}

const openSwitcher = async () => {
    fireEvent.click(await screen.findByLabelText('Switch project'));
};

beforeEach(() => {
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

describe('the project switcher in the header', () => {
    it('renders nothing once the registered projects have loaded and there is only one', async () => {
        const listProjects = stubProjectsEndpoint(['demo']);

        renderApp('/projects/demo');
        await screen.findByText('0 cards');
        await waitFor(() => expect(listProjects).toHaveBeenCalled());

        expect(screen.queryByLabelText('Switch project')).toBeNull();
    });

    it('lists every registered project once two or more are registered', async () => {
        stubProjectsEndpoint(['demo', 'other']);

        renderApp('/projects/demo');
        await openSwitcher();

        const items = await screen.findAllByRole('menuitem');
        expect(items.map(item => item.textContent)).toEqual(['demo', 'other']);
    });

    it('marks the project on screen, and only that one, as current', async () => {
        stubProjectsEndpoint(['demo', 'other']);

        renderApp('/projects/demo');
        await openSwitcher();

        const items = await screen.findAllByRole('menuitem');
        const current = items.find(item => item.textContent === 'demo')!;
        const other = items.find(item => item.textContent === 'other')!;

        expect(current.querySelector('svg')).toBeTruthy();
        expect(other.querySelector('svg')).toBeNull();
    });

    // `ProjectSwitcher.tsx`'s own doc comment: a route with no `project` param of its own (like the
    // deleted top-level board, now a 404 — card 0155) falls back to the daemon's own configured
    // project, `health.data.project`, the same fallback `FlaggedIndicator` already uses.
    it('marks the daemon\'s own configured project as current on a route with no project param', async () => {
        stubProjectsEndpoint(['demo', 'other']);

        renderApp('/');
        await openSwitcher();

        const items = await screen.findAllByRole('menuitem');
        const current = items.find(item => item.textContent === 'demo')!;
        const other = items.find(item => item.textContent === 'other')!;

        expect(current.querySelector('svg')).toBeTruthy();
        expect(other.querySelector('svg')).toBeNull();
    });

    it('switches projects by navigating to the picked project\'s own URL', async () => {
        stubProjectsEndpoint(['demo', 'other']);

        const { router } = renderApp('/projects/demo');
        await openSwitcher();

        fireEvent.click(await screen.findByRole('menuitem', { name: 'other' }));

        await waitFor(() => expect(router.state.location.pathname).toBe('/projects/other'));
        // The switch is a navigation, not local state: the address bar itself now names the new
        // project, and that project's own board — not a leftover from the one navigated away from —
        // is what's on screen.
        expect(await screen.findByText('0 cards')).toBeTruthy();
    });

    it('does not navigate when the project already on screen is picked again', async () => {
        stubProjectsEndpoint(['demo', 'other']);

        const { router } = renderApp('/projects/demo');
        await openSwitcher();

        fireEvent.click(await screen.findByRole('menuitem', { name: 'demo' }));

        expect(router.state.location.pathname).toBe('/projects/demo');
    });
});
