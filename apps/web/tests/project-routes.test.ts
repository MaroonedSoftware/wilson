// @vitest-environment jsdom
//
// Card 0153: the app's URLs gain a project-scoped half — `/projects/$project`,
// `/projects/$project/flagged`, `/projects/$project/cards/$cardId` — the same three screens
// `/`, `/flagged` and `/cards/$cardId` already render, reading through a client built for that
// route's own `project` param (`wilsonForProject`, `lib/sdk.ts`) instead of the app-wide singleton.
// These tests render the real route tree (the same approach flagged.test.ts and
// card-detail.actions.test.ts take), so the new routes, `AnchorLink` (the `component={Link}` fix for
// a parameterised route), and the project threaded into both SSE streams are all exercised as
// actually wired up — not re-implemented here.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, ChatClient, ProjectsClient, SdkError } from '@wilson/sdk';
import type { BoardColumns, CardDetail, CardSummary } from '@wilson/sdk';
import { API_BASE } from '#src/lib/sdk.js';
import { routeTree } from '#src/routeTree.gen.js';

const columns: BoardColumns = {
    stages: ['planning', 'implementing', 'review'],
    nonStages: ['needs-human'],
};

const cardSummary = (id: string, stage: string, needsHuman = false): CardSummary => ({
    id,
    title: `card ${id}`,
    stage,
    dependsOn: [],
    needsHuman,
});

const cardDetail = (id: string, stage: string): CardDetail => ({
    id,
    title: `card ${id}`,
    stage,
    dependsOn: [],
    needsHuman: false,
    sections: {},
    body: 'the plan',
});

const session = { sessionId: '0007', worktreePath: '/tmp/plan-0007', draftPath: '/tmp/plan-0007/PLAN.md', model: 'x', instructions: 'x' };

/** Same FakeEventSource stand-in feed.test.ts/plan.test.ts use, recording every instance's URL so a
 * test can tell the board feed and a card's plan stream apart without caring which opens first. */
class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readonly url: string;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
        const set = this.listeners.get(type) ?? new Set();
        set.add(listener);
        this.listeners.set(type, set);
    }

    close() {
        this.closed = true;
    }

    // Card 0274: `useCardFeed` now parses a `card` event's `data` as `WireCardEvent` before acting on
    // it — `'{}'` is valid JSON with no `message`, so it still exercises "the feed refetches this
    // project's board" without an empty string being silently dropped as unparseable.
    emit(type: string, data = '{}') {
        for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data }));
    }
}

const feedSource = () => FakeEventSource.instances.find(s => s.url.includes('/api/feed'));
const planStreamSources = () => FakeEventSource.instances.filter(s => s.url.includes('/plan/stream'));
const latestPlanStream = () => planStreamSources()[planStreamSources().length - 1];

/** `Board` renders inside Mantine's `ScrollArea`, which measures itself with `ResizeObserver` on
 * mount — jsdom does not implement it. Same stand-in flagged.test.ts uses. */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

const stubBrowserGlobals = () => {
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
};

/** Renders the real app router (root layout + whichever route the path resolves to). */
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

describe('a project-scoped route, reading through a client built for its own project', () => {
    beforeEach(() => {
        FakeEventSource.instances = [];
        vi.stubGlobal('EventSource', FakeEventSource);
        vi.stubGlobal('ResizeObserver', FakeResizeObserver);
        Element.prototype.scrollIntoView = vi.fn();
        Object.defineProperty(document, 'fonts', {
            value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
            configurable: true,
        });
        stubBrowserGlobals();

        // These routes call through `wilsonForProject(project)` — a client built fresh per route,
        // not the singleton `wilson` other routes use — so the mock has to sit on `BoardClient`'s
        // own prototype (shared by every instance) rather than on `wilson.board` the way
        // flagged.test.ts/card-detail.actions.test.ts mock the singleton. This also still covers
        // `FlaggedIndicator`'s own `wilson.board.listCards()` call in the shared header, since that's
        // an instance of the same class.
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);
        vi.spyOn(BoardClient.prototype, 'listCardVersions').mockResolvedValue([]);
        vi.spyOn(BoardClient.prototype, 'openAPlanningSession').mockResolvedValue(session);
        vi.spyOn(BoardClient.prototype, 'getAPlanDraft').mockResolvedValue({ body: 'the current plan body' });
    });

    afterEach(() => {
        // `apps/web/vitest.config.ts` does not set `test.globals: true`, so
        // `@testing-library/react`'s own auto-cleanup never registers — without this, each test's
        // `render()` piles onto the previous test's DOM instead of replacing it.
        cleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('shows that project\'s board at /projects/$project, the same screen / renders', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([cardSummary('0001', 'planning')]);

        renderApp('/projects/demo');

        expect(await screen.findByText('1 cards')).toBeTruthy();
        expect(await screen.findByText('card 0001')).toBeTruthy();
    });

    it('opens the shared board feed naming the route\'s project, unlike the top-level board\'s own feed', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([]);

        renderApp('/projects/demo');
        await screen.findByText('0 cards');

        expect(feedSource()?.url).toContain('/api/feed?project=demo');
    });

    // Card 0154: `useCardFeed` used to invalidate only the plain `['cards']` key regardless of
    // project — a key this screen's own board query (`['project', project, 'cards']`, above) never
    // used, so a card event on this project's own feed could never actually refetch this board; only
    // an unrelated remount or manual refresh would ever show a new card. Driving the real feed
    // connection and watching the new card land with no manual refresh proves the scoped key this
    // card added now actually matches what this screen reads.
    it('refetches this project\'s board on its own feed\'s card event, with no manual refresh', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        const listCards = vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([]);

        renderApp('/projects/demo');
        await screen.findByText('0 cards');
        // Two calls on mount, same as the "sends X-Wilson-Project" test above notes: the
        // project-scoped board itself, plus the shared header's `FlaggedIndicator`, which still
        // reads the unscoped singleton's own `['cards']` key — a different cache entry from this
        // board's `['project', 'demo', 'cards']`, but the same `BoardClient.prototype` method.
        const callsOnMount = listCards.mock.calls.length;

        listCards.mockResolvedValue([cardSummary('0001', 'planning')]);
        await act(async () => {
            feedSource()?.emit('card');
        });

        // Two more calls: this board's own scoped query refetching (the point of this test), plus
        // the shared header's unscoped `['cards']` query — `useCardFeed` invalidates both on a
        // project-scoped event (`feed.ts`'s own doc comment), so `FlaggedIndicator`'s live count
        // keeps working here too, exactly as it did before this card.
        expect(await screen.findByText('card 0001')).toBeTruthy();
        expect(listCards).toHaveBeenCalledTimes(callsOnMount + 2);
    });

    // Card 0155 deleted the top-level board route in the same change that moved every link onto
    // its `/projects/$project` counterpart, so a stray old bookmark of `/` never lands on a board. Card
    // 0169 gave `/` the dashboard; the chat has it now (`routes/index.tsx`), and the dashboard is at
    // `/projects`. Neither is a board: no card count, no per-project fetch. The shell around them
    // (the header, the feed subscription in `__root.tsx`) still mounts regardless.
    it('renders the chat, not a board, at the top-level route', async () => {
        vi.spyOn(ProjectsClient.prototype, 'listProjects').mockResolvedValue([{ name: 'demo' }]);
        vi.spyOn(ChatClient.prototype, 'listChatThreads').mockResolvedValue([]);

        renderApp('/');

        expect(await screen.findByText('What should we do?')).toBeTruthy();
        expect(screen.queryByText(/\d+ cards/)).toBeNull();
        // The shell itself is unaffected: the header's own feed subscription (unscoped — no
        // project param on this path) still opens, same as it always has.
        await waitFor(() => expect(feedSource()?.url).toBe(`${API_BASE}/api/feed`));
    });

    it('renders the dashboard, not a board, at /projects', async () => {
        vi.spyOn(ProjectsClient.prototype, 'listProjects').mockResolvedValue([{ name: 'demo' }]);

        renderApp('/projects');

        expect(await screen.findByText('Dashboard')).toBeTruthy();
        expect(screen.queryByText(/\d+ cards/)).toBeNull();
    });

    it('shows only that project\'s flagged cards at /projects/$project/flagged, and its back link returns to that project\'s board', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([cardSummary('0001', 'planning'), cardSummary('0002', 'review', true)]);

        const { router } = renderApp('/projects/demo/flagged');

        await screen.findByText('card 0002');
        expect(screen.queryByText('card 0001')).toBeNull();

        // `AnchorLink` (`lib/router-link.tsx`) is this card's fix for Mantine's `component={Link}`
        // erasing TanStack's typed `params` against a parameterised route — following it here proves
        // it actually renders a working link, not just a type that compiles.
        fireEvent.click(screen.getByText('← Back to the board'));

        await waitFor(() => expect(router.state.location.pathname).toBe('/projects/demo'));
    });

    it('sends Settings back to the project it was opened from, and to the projects list otherwise', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([]);

        const { router } = renderApp('/projects/demo');

        fireEvent.click(await screen.findByLabelText('Settings'));
        await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
        expect((await screen.findByText('← Back to the board')).getAttribute('href')).toBe('/projects/demo');

        await router.navigate({ to: '/settings' });
        expect((await screen.findByText('← Back to projects')).getAttribute('href')).toBe('/projects');
    });

    it('renders a card\'s own page at /projects/$project/cards/$cardId, reached through the project-scoped client', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(cardDetail('0007', 'review'));

        renderApp('/projects/demo/cards/0007');

        expect(await screen.findByText('card 0007')).toBeTruthy();
        expect(screen.getByText('0007')).toBeTruthy();
    });

    it('shows a project-aware back link when a project-scoped card fails to load, pointing at that project\'s board rather than the top-level one', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'getCard').mockRejectedValue(new SdkError(404, 'Not Found', { reason: 'no such card' }, new Headers()));

        renderApp('/projects/demo/cards/0007');

        expect(await screen.findByText('Cannot load this card')).toBeTruthy();
        const backLink = screen.getByText('← Back to the board') as HTMLAnchorElement;
        expect(backLink.getAttribute('href')).toBe('/projects/demo');
    });

    it('threads the project into the planning stream for a planning-stage card reached at its project-scoped URL', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(cardDetail('0007', 'planning'));

        renderApp('/projects/demo/cards/0007');

        await screen.findByText('card 0007');
        await waitFor(() => expect(planStreamSources()).toHaveLength(1));
        expect(latestPlanStream().url).toBe(`${API_BASE}/api/cards/0007/plan/stream?project=demo`);
        // The board feed mounted by the shared header also names the same project — one client, one
        // project, not a screen split between two.
        expect(feedSource()?.url).toContain('/api/feed?project=demo');
    });
});

/**
 * The suite above mocks `BoardClient.prototype` directly — enough to prove the routes render and
 * thread `project` through, but it never actually calls `fetch`, so it can't see the one thing
 * `wilsonForProject` exists to do: put `X-Wilson-Project` on the wire (`sdk.test.ts` proves that in
 * isolation for the SDK itself). This block stubs `fetch` instead, one level lower, so the header on
 * an actual outgoing request from a rendered `/projects/$project` route is what's asserted — no
 * `BoardClient` mock standing in between.
 */
describe('a project-scoped route, sending its project over the wire', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        FakeEventSource.instances = [];
        vi.stubGlobal('EventSource', FakeEventSource);
        vi.stubGlobal('ResizeObserver', FakeResizeObserver);
        stubBrowserGlobals();

        fetchMock = vi.fn(async (url: string) => {
            if (url === `${API_BASE}/api/cards`) {
                return new Response(JSON.stringify([cardSummary('0001', 'planning')]), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url === `${API_BASE}/api/stages`) {
                return new Response(JSON.stringify(columns), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            throw new Error(`unexpected fetch to ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('sends X-Wilson-Project naming the route\'s project on the board\'s own /api/cards request, unlike the header\'s own singleton-backed request for the same path', async () => {
        renderApp('/projects/demo');

        await screen.findByText('card 0001');

        const cardsCalls = fetchMock.mock.calls.filter(([url]: [string]) => url === `${API_BASE}/api/cards`);
        // Two calls hit the same path: the project-scoped board itself, and `FlaggedIndicator` in
        // the shared header, which still reads through the app-wide singleton (this card's plan
        // defers that propagation to [[0155]]) — so exactly one of the two carries the header.
        expect(cardsCalls).toHaveLength(2);
        const projectHeaders = cardsCalls.map(([, init]: [string, RequestInit]) => (init.headers as Record<string, string>)['X-Wilson-Project']);
        expect(projectHeaders).toContain('demo');
        expect(projectHeaders).toContain(undefined);
    });
});
