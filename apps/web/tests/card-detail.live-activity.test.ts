import { DateTime } from 'luxon';
// @vitest-environment jsdom
//
// Card 0274: `CardDetail.tsx` wires `LiveActivity` (covered directly, in isolation, by
// `live-activity.test.ts`) into the card page itself — a "Live activity" panel seeded from the
// card's already-fetched events (`listCardEvents`, AC6) and updated live off the same feed
// subscription the board tile reads (`board.activity.test.ts`). This file proves the wiring: the
// panel actually appears on the real route, actually seeds from what `listCardEvents` returned, and
// actually grows when the card's own feed delivers a fresh `tool.*` event. Follows the same
// "render the real route tree with the SDK mocked" approach `card-detail.diff.test.ts` takes. The
// panel does not exist at all on the pre-change tree, so every "Live activity" assertion below fails
// there.
import { createElement } from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient } from '@wilson/sdk';
import type { BoardColumns, CardDetail, CardEvent } from '@wilson/sdk';
import { routeTree } from '#src/routeTree.gen.js';

const CARD_PATH = '/projects/demo/cards/0007';

const columns: BoardColumns = {
    stages: ['planning', 'implementing', 'testing'],
    nonStages: ['parking-lot', 'merged'],
};

const card = (overrides: Partial<CardDetail> = {}): CardDetail => ({
    id: '0007',
    title: 'Do the thing',
    stage: 'testing',
    dependsOn: [],
    needsHuman: false,
    sections: {},
    body: 'the plan',
    ...overrides,
});

const toolEvent = (overrides: Partial<CardEvent> = {}): CardEvent => ({
    id: 'ev-1',
    type: 'tool.executed',
    stage: 'testing',
    payload: { tool: 'bash', command: 'pnpm test' },
    createdAt: DateTime.fromISO('2026-01-10T11:59:00.000Z'),
    ...overrides,
});

/** Same stand-in `flagged.test.ts`/`board.activity.test.ts` use — a working `emit`, since one test
 * below drives the root layout's own feed subscription to prove the panel updates live. */
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
    vi.spyOn(BoardClient.prototype, 'listCardVersions').mockResolvedValue([]);
    vi.spyOn(BoardClient.prototype, 'listBoardColumns').mockResolvedValue(columns);
    vi.spyOn(BoardClient.prototype, 'getCardUsage').mockResolvedValue({ total: { attempts: 0, inputTokens: 0, outputTokens: 0 }, stages: [] });
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    Element.prototype.scrollIntoView = vi.fn();
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
    Object.defineProperty(document, 'fonts', {
        value: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
        configurable: true,
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    notifications.clean();
});

describe('the card page\'s Live activity panel', () => {
    it('renders a "Live activity" heading on the card page', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);

        renderApp(CARD_PATH);

        expect(await screen.findByRole('heading', { name: 'Live activity' })).toBeTruthy();
    });

    it('seeds from the card\'s already-fetched events, so opening the page mid-run is not empty (AC6)', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([toolEvent({ payload: { tool: 'bash', command: 'pnpm build' } })]);

        renderApp(CARD_PATH);

        await screen.findByText('Do the thing');
        expect(await screen.findByText('pnpm build')).toBeTruthy();
    });

    it('shows a fresh tool.* event delivered over the feed after the page has already loaded', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');
        expect(screen.getByText('No tool calls yet.')).toBeTruthy();

        act(() =>
            feedSource()!.emit(
                'card',
                wireEvent({
                    correlationId: '0007',
                    message: 'tool.executed',
                    stage: 'testing',
                    ts: new Date().toISOString(),
                    payload: { tool: 'write', path: 'apps/web/src/new-file.ts' },
                }),
            ),
        );

        expect(await screen.findByText('apps/web/src/new-file.ts')).toBeTruthy();
        expect(screen.queryByText('No tool calls yet.')).toBeNull();
    });

    it('leaves the existing "Events" timeline section in place, both sections coexisting (AC8)', async () => {
        vi.spyOn(BoardClient.prototype, 'getCard').mockResolvedValue(card());
        vi.spyOn(BoardClient.prototype, 'listCardEvents').mockResolvedValue([toolEvent({ id: 'ev-2' })]);

        renderApp(CARD_PATH);
        await screen.findByText('Do the thing');

        // The events timeline lower on the page still renders its own "Events" heading and the raw
        // event type as a Timeline item title — the live panel above it is additional, not a
        // replacement.
        expect(await screen.findByRole('heading', { name: 'Live activity' })).toBeTruthy();
        expect(await screen.findByRole('heading', { name: 'Events' })).toBeTruthy();
        expect(within(document.body).getAllByText('tool.executed').length).toBeGreaterThan(0);
    });
});
