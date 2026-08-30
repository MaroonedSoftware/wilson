// @vitest-environment jsdom
//
// Card 0156: a component now takes its SDK client from `useWilsonSdk()`, reading whatever
// `WilsonSdkProvider` the route rendering it established, instead of importing the `wilson`
// singleton (or `wilsonForProject`) directly. `lib/sdk-context.tsx` is new; these tests cover the
// module itself — a missing provider fails loudly rather than falling back, and a provider's
// client is exactly what the hook returns — plus the one thing that could not have been true
// before this card: a component that used to import `wilson` unconditionally now reaches the
// project-scoped client when it is rendered under a `/projects/$project/*` route. That's proven at
// the wire, the same way `project-routes.test.ts` proves `wilsonForProject` itself sends
// `X-Wilson-Project` — by stubbing global `fetch` and reading the header an actual outgoing
// request carries, not by mocking `BoardClient` and taking the plumbing on faith.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead.
import { createElement } from 'react';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, WilsonSdk } from '@wilson/sdk';
import type { BoardColumns, CardDetail } from '@wilson/sdk';
import { API_BASE } from '#src/lib/sdk.js';
import { WilsonSdkProvider, useWilsonSdk } from '#src/lib/sdk-context.js';
import { routeTree } from '#src/routeTree.gen.js';

describe('useWilsonSdk / WilsonSdkProvider', () => {
    it('throws rather than falling back when called with no provider above it', () => {
        // "A missing provider is a mistake, not a fallback" (this card's Constraints) — a component
        // rendered outside a `WilsonSdkProvider` must fail loudly, never silently resolve to some
        // default client and talk to the wrong project.
        expect(() => renderHook(() => useWilsonSdk())).toThrow(
            'useWilsonSdk() called with no WilsonSdkProvider above it in the tree.',
        );
    });

    it('returns exactly the client instance passed to the nearest surrounding provider', () => {
        const client = new WilsonSdk({ baseUrl: API_BASE });
        const wrapper = ({ children }: { children: React.ReactNode }) =>
            createElement(WilsonSdkProvider, { client }, children);

        const { result } = renderHook(() => useWilsonSdk(), { wrapper });

        expect(result.current).toBe(client);
    });

    it('lets an inner provider override an outer one for whatever renders beneath it', () => {
        const outer = new WilsonSdk({ baseUrl: API_BASE });
        const inner = new WilsonSdk({ baseUrl: API_BASE, project: 'demo' });
        const wrapper = ({ children }: { children: React.ReactNode }) =>
            createElement(WilsonSdkProvider, { client: outer }, createElement(WilsonSdkProvider, { client: inner }, children));

        const { result } = renderHook(() => useWilsonSdk(), { wrapper });

        expect(result.current).toBe(inner);
    });
});

/**
 * The behavioural half: before this card, `CardDetail.tsx`'s merge control and
 * `PlanningSession.tsx`'s session-open call both imported the `wilson` singleton directly, so a
 * card reached through `/projects/$project/cards/$cardId` still merged and opened its planning
 * session against the *unscoped* client — the exact bug this card exists to fix. Now both read
 * through `useWilsonSdk()`, and `projects.$project.cards.$cardId.tsx` wraps its subtree in a
 * `WilsonSdkProvider` carrying `wilsonForProject(project)`, so those same two calls carry
 * `X-Wilson-Project` naming the route's project. Rendering the real route tree and stubbing
 * `fetch` (rather than mocking `BoardClient`) is what actually lets that header be observed —
 * `project-routes.test.ts`'s "sending its project over the wire" block takes the same approach for
 * the routes' own reads.
 */
describe('a component reached through a project-scoped route now merges and opens sessions against that project', () => {
    const columns: BoardColumns = {
        stages: ['planning', 'implementing', 'ready'],
        nonStages: ['merged'],
    };

    const cardDetail = (id: string, stage: string): CardDetail => ({
        id,
        title: `card ${id}`,
        stage,
        dependsOn: [],
        needsHuman: false,
        sections: {},
        body: 'the plan',
    });

    /** Same FakeEventSource stand-in project-routes.test.ts uses — the shared header's board feed,
     * and (for the planning-stage test below) the planning stream, both open one on mount. */
    class FakeEventSource {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        addEventListener() {}
        close() {}
    }

    class FakeResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    }

    let fetchMock: ReturnType<typeof vi.fn>;

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
    }

    beforeEach(() => {
        vi.stubGlobal('EventSource', FakeEventSource);
        vi.stubGlobal('ResizeObserver', FakeResizeObserver);
        Element.prototype.scrollIntoView = vi.fn();
        Object.defineProperty(document, 'fonts', {
            value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
            configurable: true,
        });
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

        // Everything but the call under test in each `it` below is mocked at the `BoardClient`
        // prototype level (shared by `wilson`, `wilsonForProject(...)`, and every route's own
        // client, since they're all instances of the same class) — enough to get the route past
        // loading without asserting anything about how those particular calls reach the wire.
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);
        vi.spyOn(BoardClient.prototype, 'listCardVersions').mockResolvedValue([]);
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([]);
        vi.spyOn(BoardClient.prototype, 'getAPlanDraft').mockResolvedValue({ body: 'the current draft' });

        fetchMock = vi.fn(async (url: string) => {
            throw new Error(`unexpected fetch to ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('sends X-Wilson-Project naming the route\'s project on the merge request the button fires', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(cardDetail('0007', 'ready'));
        fetchMock.mockImplementation(async (url: string) => {
            if (url === `${API_BASE}/api/cards/0007/merge`) {
                return new Response(JSON.stringify({ ...cardDetail('0007', 'merged'), merged: true, commit: 'abc1234def5678' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            throw new Error(`unexpected fetch to ${url}`);
        });

        renderApp('/projects/demo/cards/0007');
        await screen.findByText('card 0007');

        const button = await screen.findByRole('button', { name: 'Merge' });
        fireEvent.click(button);

        await screen.findByText('Merged');

        const mergeCalls = fetchMock.mock.calls.filter(([url]: [string]) => url === `${API_BASE}/api/cards/0007/merge`);
        expect(mergeCalls).toHaveLength(1);
        const [, init] = mergeCalls[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>)['X-Wilson-Project']).toBe('demo');
    });

    it('sends X-Wilson-Project naming the route\'s project when opening the planning session on mount', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(cardDetail('0007', 'planning'));
        fetchMock.mockImplementation(async (url: string) => {
            if (url === `${API_BASE}/api/cards/0007/plan/open`) {
                return new Response(
                    JSON.stringify({ sessionId: '0007', worktreePath: '/tmp/plan-0007', draftPath: '/tmp/plan-0007/PLAN.md', model: 'x', instructions: 'x' }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                );
            }
            throw new Error(`unexpected fetch to ${url}`);
        });

        renderApp('/projects/demo/cards/0007');
        await screen.findByText('card 0007');

        const openCalls = () => fetchMock.mock.calls.filter(([url]: [string]) => url === `${API_BASE}/api/cards/0007/plan/open`);
        await vi.waitFor(() => expect(openCalls()).toHaveLength(1));

        const [, init] = openCalls()[0] as [string, RequestInit];
        expect((init.headers as Record<string, string>)['X-Wilson-Project']).toBe('demo');
    });
});
