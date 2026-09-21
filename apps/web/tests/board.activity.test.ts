// @vitest-environment jsdom
//
// Card 0274: a board tile's "last event" line (AC2-AC5), rendered from the one feed subscription
// `__root.tsx` already owns (`CardActivityContext`, `lib/feed.ts`) rather than a second one of its
// own. Renders the real route tree, the same approach `flagged.test.ts` takes for the same reason —
// so the tile, the context wiring and the display rule (`showsLastEventLine`, `lib/board.ts`) are all
// exercised as actually wired up. None of this rendering exists on the pre-change tree (the tile has
// no "last event" line at all there), so every "shows" assertion below fails there.
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient } from '@wilson/sdk';
import type { BoardColumns, CardSummary } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

const columns: BoardColumns = {
    stages: ['implementing', 'testing'],
    nonStages: ['merged'],
};

const card = (id: string, stage: string): CardSummary => ({
    id,
    title: `card ${id}`,
    stage,
    dependsOn: [],
    needsHuman: false,
});

/** Same stand-in `feed.test.ts`/`flagged.test.ts` use — unlike `board.tiles.test.ts`'s no-op
 * version, this one actually records and fires listeners, since these tests drive the board's own
 * feed subscription to prove the tile's "last event" line reacts to it live. */
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

    emit(type: string, data: string) {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(new MessageEvent(type, { data }));
        }
    }
}

const feedSource = () => FakeEventSource.instances.find(source => source.url.includes('/api/feed'));

/** Builds the JSON text a `card` SSE event carries — see `feed.ts`'s `WireCardEvent`. */
const wireEvent = ({
    id = 1,
    ts,
    message,
    correlationId,
    stage,
    payload = null,
}: {
    id?: number;
    ts: string;
    message: string;
    correlationId: string;
    stage: string | null;
    payload?: unknown;
}) => JSON.stringify({ id, ts, message, correlationId, data: { stage, payload } });

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
    FakeEventSource.instances = [];
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
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the board tile\'s last event line', () => {
    it('shows no last-event line before any feed event has arrived for the card', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'implementing')]);

        renderApp('/projects/demo');

        const title = await screen.findByText('card 0001');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(tile.textContent).not.toMatch(/last event/);
    });

    it('shows "last event Xs ago" once a stage.dispatched event names the card\'s own current stage (AC2)', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0001', 'implementing')]);

        renderApp('/projects/demo');
        await screen.findByText('card 0001');

        act(() =>
            feedSource()!.emit(
                'card',
                wireEvent({ correlationId: '0001', message: 'stage.dispatched', stage: 'implementing', ts: new Date().toISOString() }),
            ),
        );

        const title = await screen.findByText('card 0001');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(tile.textContent).toMatch(/last event \d+s ago/);
    });

    it('shows the line for a tool.* event in the card\'s own current stage too', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0002', 'testing')]);

        renderApp('/projects/demo');
        await screen.findByText('card 0002');

        act(() =>
            feedSource()!.emit(
                'card',
                wireEvent({ correlationId: '0002', message: 'tool.executed', stage: 'testing', ts: new Date().toISOString() }),
            ),
        );

        const title = await screen.findByText('card 0002');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(tile.textContent).toMatch(/last event \d+s ago/);
    });

    it('does not show the line when the event\'s own stage differs from the card\'s current stage (AC5)', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0003', 'testing')]);

        renderApp('/projects/demo');
        await screen.findByText('card 0003');

        act(() =>
            feedSource()!.emit(
                'card',
                wireEvent({ correlationId: '0003', message: 'tool.executed', stage: 'implementing', ts: new Date().toISOString() }),
            ),
        );

        const title = await screen.findByText('card 0003');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(tile.textContent).not.toMatch(/last event/);
    });

    it('does not show the line for an event type that is neither stage.dispatched nor tool.* (AC5)', async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0004', 'testing')]);

        renderApp('/projects/demo');
        await screen.findByText('card 0004');

        act(() =>
            feedSource()!.emit(
                'card',
                wireEvent({ correlationId: '0004', message: 'stage.completed', stage: 'testing', ts: new Date().toISOString() }),
            ),
        );

        const title = await screen.findByText('card 0004');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        expect(tile.textContent).not.toMatch(/last event/);
    });

    it("reads the event's own publish time, not receipt time, so a stale connect-snapshot event renders its true age (AC3, AC4)", async () => {
        vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
        vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([card('0005', 'testing')]);

        renderApp('/projects/demo');
        await screen.findByText('card 0005');

        // Published ten minutes ago — past LAST_EVENT_STALE_MS (five minutes) — even though it is
        // only "received" right now, proving the age comes from `ts`, not `Date.now()` at receipt.
        const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
        act(() =>
            feedSource()!.emit(
                'card',
                wireEvent({ correlationId: '0005', message: 'stage.dispatched', stage: 'testing', ts: tenMinutesAgo }),
            ),
        );

        const title = await screen.findByText('card 0005');
        const tile = title.closest('.mantine-Paper-root') as HTMLElement;
        await waitFor(() => expect(tile.textContent).toMatch(/last event 10m ago/));
    });
});
