// @vitest-environment jsdom
//
// The activity page through the real route tree: header link, history paging, and the live refresh
// that rides `__root.tsx`'s one feed connection.
import { createElement } from 'react';
import { DateTime } from 'luxon';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, HealthClient } from '@wilson/sdk';
import type { ActivityEvent, Health } from '@wilson/sdk';
import { routeTree } from '../src/routeTree.gen.js';

const event = (id: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
    id: String(id),
    cardId: '0001',
    cardTitle: 'Ship it',
    type: 'stage.passed',
    stage: 'review',
    payload: {},
    createdAt: DateTime.utc(),
    ...overrides,
});

class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onopen: (() => void) | undefined;
    onerror: (() => void) | undefined;
    private readonly listeners = new Map<string, (event: MessageEvent) => void>();

    constructor(public readonly url: string) {
        FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
        this.listeners.set(type, listener);
    }

    close() {}

    emit(data: unknown) {
        this.listeners.get('card')?.(new MessageEvent('card', { data: JSON.stringify(data) }));
    }
}

const renderApp = () => {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/projects/demo/activity'] }) });
    const queryClient = new QueryClient();
    render(
        createElement(MantineProvider, null, createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router }))),
    );
};

beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })),
    );
    vi.spyOn(HealthClient.prototype, 'getHealth').mockResolvedValue({ ok: true, project: 'demo' } as unknown as Health);
    vi.spyOn(BoardClient.prototype, 'listCards').mockResolvedValue([]);
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the activity page', () => {
    it('shows each event with its card and reason, and links from the header', async () => {
        vi.spyOn(BoardClient.prototype, 'listProjectActivity').mockResolvedValue([
            event(2, { type: 'stage.failed', stage: 'testing', payload: { reason: 'tests failed' } }),
            event(1, { cardId: '0002', cardTitle: null }),
        ]);

        renderApp();

        expect(await screen.findByText('Failed testing')).toBeTruthy();
        expect(screen.getByText('tests failed')).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Ship it' }).getAttribute('href')).toBe('/projects/demo/cards/0001');
        expect(screen.getByRole('link', { name: '0002' })).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Activity' }).getAttribute('href')).toBe('/projects/demo/activity');
    });

    it('says so when nothing has happened', async () => {
        vi.spyOn(BoardClient.prototype, 'listProjectActivity').mockResolvedValue([]);

        renderApp();

        expect(await screen.findByText('Nothing has happened in this project yet.')).toBeTruthy();
    });

    it('reads further back from the oldest event it holds', async () => {
        const list = vi
            .spyOn(BoardClient.prototype, 'listProjectActivity')
            .mockResolvedValueOnce(Array.from({ length: 50 }, (_, index) => event(100 - index)))
            .mockResolvedValueOnce([event(10, { type: 'work.committed', stage: null })]);

        renderApp();
        fireEvent.click(await screen.findByRole('button', { name: 'Show older' }));

        expect(await screen.findByText('Committed work')).toBeTruthy();
        expect(list).toHaveBeenLastCalledWith({ limit: 50, before: 51 });
        expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
    });
});
