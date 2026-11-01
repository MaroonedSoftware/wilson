import { DateTime } from 'luxon';
// @vitest-environment jsdom
//
// Card 0119: an aggregate count of cards needing a human, shown in the shared header
// (`FlaggedIndicator`, mounted by `__root.tsx`) and linking to a project's flagged view, built from
// the same `Board` component card 0057 already renders red borders and reason badges with. These
// tests render the real route tree — header, live feed wiring, and the flagged route all exercised
// as written, not re-implemented here — the same approach settings.test.ts takes for card 0114/0115.
//
// Card 0155 deleted the top-level `/` board and moved `/flagged` to `/projects/$project/flagged`.
// The board itself is now only ever reached at `/projects/$project`, whose route reads through
// `wilsonForProject(project)` (`projects.$project.index.tsx`) rather than the singleton `wilson` —
// so the mocks below sit on `BoardClient`/`HealthClient`'s own prototypes (shared by every instance,
// the singleton `FlaggedIndicator` itself reads through included), the same fix
// `project-routes.test.ts` made for the same reason. `FlaggedIndicator`'s own link now names the
// project from `health.data.project` (`FlaggedIndicator.tsx`), so `baseHealth.project` below is the
// same project every test opens the board at, keeping the header's link and the rendered board
// pointed at the same place.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, HealthClient } from '@wilson/sdk';
import type { BoardColumns, CardSummary, Health } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { routeTree } from '#src/routeTree.gen.js';

/** Every test below that renders the board opens it at this project-scoped URL. */
const BOARD_PATH = '/projects/demo';
const FLAGGED_PATH = '/projects/demo/flagged';

const card = (id: string, stage: string, needsHuman = false, dependsOn: string[] = []): CardSummary => ({
    id,
    title: `card ${id}`,
    stage,
    dependsOn,
    needsHuman,
});

const columns: BoardColumns = {
    stages: ['planning', 'implementing', 'review'],
    nonStages: ['needs-human'],
};

const baseHealth: Health = {
    ok: true,
    project: 'demo',
    head: 'abc1234',
    startedAt: DateTime.fromISO('2026-01-01T00:00:00.000Z'),
    codeRoot: '/deploy/code',
    worktreeRoot: '/deploy/worktrees',
};

/**
 * A stand-in for the browser's `EventSource` that can actually emit a `card` event — unlike
 * settings.test.ts's version (which only needs the app to survive mounting `useCardFeed`), the
 * "live" tests below drive the feed to prove the header count updates off the one subscription
 * `__root.tsx` already owns, with no reload and no second subscription of its own.
 */
class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

    constructor(public readonly url: string) {
        FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
        const set = this.listeners.get(type) ?? new Set();
        set.add(listener);
        this.listeners.set(type, set);
    }

    close() {}

    // Card 0274: `useCardFeed` now parses a `card` event's `data` as `WireCardEvent` before acting on
    // it — `'{}'` is valid JSON with no `message`, so it still exercises the header's live update
    // without an empty string being silently dropped as unparseable.
    emit(type: string, data = '{}') {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(new MessageEvent(type, { data }));
        }
    }
}

/**
 * `Board` renders inside Mantine's `ScrollArea`, which measures itself with `ResizeObserver` on
 * mount — jsdom does not implement it, and every test here renders `Board` (via `/`, `/settings`'s
 * shared header, or `/flagged` itself), not just the ones about scrolling.
 */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

/** Renders the real app router (root layout + whichever route the path resolves to). */
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

beforeEach(() => {
    FakeEventSource.instances = [];
    vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
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

describe('the flagged count in the header', () => {
    it('shows nothing when no card needs a human', async () => {
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'planning'), card('0002', 'review')]);

        renderApp(BOARD_PATH);

        await screen.findByText('planning'); // board has loaded
        expect(screen.queryByText(/needs human/)).toBeNull();
    });

    it('shows the count of flagged cards, wherever they sit on the board', async () => {
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([
            card('0001', 'planning'),
            card('0002', 'review', true),
            card('0003', 'implementing', true),
        ]);

        renderApp(BOARD_PATH);

        expect(await screen.findByText('2 needs human')).toBeTruthy();
    });

    it('is visible from /settings, not only the board', async () => {
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'review', true)]);
        vi.spyOn(wilson.settings, 'getPollerSetting').mockResolvedValue({ enabled: false });

        renderApp('/settings');

        expect(await screen.findByText('1 needs human')).toBeTruthy();
        // this is the settings page, not the board, proving the count is the shared header's
        expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy();
    });

    it('increments live as a card is flagged while the page is open, with no reload', async () => {
        const listCards = vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'review')]);

        renderApp(BOARD_PATH);
        await screen.findByText('review'); // board loaded, count starts silent
        expect(screen.queryByText(/needs human/)).toBeNull();

        listCards.mockResolvedValue([card('0001', 'review', true)]);
        const source = FakeEventSource.instances[0]!;
        await act(async () => {
            source.emit('card');
        });

        expect(await screen.findByText('1 needs human')).toBeTruthy();
    });

    it('decrements live as a card is acked, with no reload', async () => {
        const listCards = vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'review', true)]);

        renderApp(BOARD_PATH);
        expect(await screen.findByText('1 needs human')).toBeTruthy();

        listCards.mockResolvedValue([card('0001', 'review', false)]);
        const source = FakeEventSource.instances[0]!;
        await act(async () => {
            source.emit('card');
        });

        // Scoped to the header: the board itself (`Board.tsx`'s own per-card "needs human" badge,
        // card 0057) is a *project-scoped* query the feed's `['cards']` invalidation does not reach
        // — scoping the card feed to a project is card [[0154]]'s job, out of this card's scope — so
        // the board keeps showing the acked card as flagged until an unrelated refetch reconciles it.
        // The header's own count, read through the same unscoped `['cards']` query the feed does
        // invalidate, is what this test is actually about.
        const header = document.querySelector('header')!;
        await waitFor(() => expect(within(header).queryByText(/needs human/)).toBeNull());
    });

    it('sends you to the flagged cards themselves when clicked, not a page that just says a number', async () => {
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'review', true)]);

        renderApp(BOARD_PATH);
        const badge = await screen.findByText('1 needs human');
        fireEvent.click(badge);

        expect(await screen.findByText('Cards needing a human')).toBeTruthy();
        expect(await screen.findByText('card 0001')).toBeTruthy();
    });
});

describe('the /flagged route', () => {
    it('says nothing is flagged rather than an empty board when there are no flagged cards', async () => {
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'planning'), card('0002', 'review')]);

        renderApp(FLAGGED_PATH);

        expect(await screen.findByText('Nothing is flagged right now.')).toBeTruthy();
    });

    it('shows only the flagged cards, not the whole board', async () => {
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'planning'), card('0002', 'review', true)]);

        renderApp(FLAGGED_PATH);

        await screen.findByText('card 0002');
        expect(screen.queryByText('card 0001')).toBeNull();
    });

    it('does not falsely mark a flagged card "blocked on" a dependency that merged but is not itself flagged', async () => {
        // `/flagged` passes only the flagged subset to `Board` as `cards`, but a dependency that
        // finished (`merged`) and was never flagged is absent from that subset. Board's dependency
        // lookup (`stageById`, built by `lib/board.ts`'s `stagesById`) has to be built from the full
        // card list — passed separately as `allCards` — or a merged-but-unflagged dependency reads
        // as missing from the board, and `unfinishedDeps` treats "missing" the same as "unfinished".
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([
            card('0001', 'merged', false),
            card('0002', 'review', true, ['0001']),
        ]);

        renderApp(FLAGGED_PATH);

        await screen.findByText('card 0002');
        expect(screen.queryByText(/blocked on/)).toBeNull();
    });

    it('still flags a dependency that is genuinely unfinished, on the flagged card it belongs to', async () => {
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([
            card('0001', 'implementing', false),
            card('0002', 'review', true, ['0001']),
        ]);

        renderApp(FLAGGED_PATH);

        await screen.findByText('card 0002');
        expect(await screen.findByText('blocked on 0001')).toBeTruthy();
    });
});
