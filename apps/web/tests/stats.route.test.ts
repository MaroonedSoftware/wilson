// @vitest-environment jsdom
//
// The stats page through the real route tree: header link, the window picker, and the live refresh
// that rides `__root.tsx`'s one feed connection.
import { createElement } from 'react';
import { DateTime } from 'luxon';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient, HealthClient } from '@wilson/sdk';
import type { Health, ProjectGateStats, ProjectStats } from '@wilson/sdk';
import { routeTree } from '../src/routeTree.gen.js';

const counts = (overrides: Partial<ProjectStats['total']> = {}) => ({
    attempts: 0,
    passed: 0,
    failed: 0,
    interrupted: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    ...overrides,
});

const stats: ProjectStats = {
    since: DateTime.utc(2026, 1, 13),
    until: DateTime.utc(2026, 1, 15),
    zone: 'America/New_York',
    total: {
        ...counts({ attempts: 4, passed: 3, failed: 1, interrupted: 1, inputTokens: 1_000_000, cachedInputTokens: 750_000, outputTokens: 12_345 }),
        cards: 2,
    },
    stages: [
        {
            stage: 'implementing',
            cards: 2,
            ...counts({ attempts: 3, passed: 2, failed: 1, interrupted: 1, inputTokens: 900_000, cachedInputTokens: 700_000, outputTokens: 12_000 }),
        },
        { stage: 'review', cards: 1, ...counts({ attempts: 1, passed: 1, inputTokens: 100_000, cachedInputTokens: 50_000, outputTokens: 345 }) },
    ],
    days: [
        { date: '2026-01-13', ...counts({ attempts: 4, passed: 3, failed: 1, outputTokens: 12_345 }) },
        { date: '2026-01-14', ...counts() },
    ],
    topCards: [
        { cardId: '0001', cardTitle: 'Ship it', ...counts({ attempts: 3, outputTokens: 12_000 }) },
        { cardId: '0002', ...counts({ attempts: 1, outputTokens: 345 }) },
    ],
    conversations: [
        { kind: 'planning', turns: 4, cards: 2, inputTokens: 60_000, cachedInputTokens: 50_000, outputTokens: 3_000 },
        { kind: 'review', turns: 1, cards: 1, inputTokens: 7_000, cachedInputTokens: 6_000, outputTokens: 500 },
    ],
};

const noGates: ProjectGateStats = {
    since: stats.since,
    until: stats.until,
    zone: stats.zone,
    kickbacks: [],
    failures: [],
    revised: [],
    challenge: { upheld: 0, overturned: 0 },
    questions: { asked: 0, answered: 0 },
    rules: [],
    loopStops: 0,
    touchpoints: [],
    firstPass: { reached: 0, firstPass: 0 },
    matched: 0,
    difficulties: [],
};

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
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/projects/demo/stats'] }) });
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
    vi.spyOn(BoardClient.prototype, 'getProjectGateStats').mockResolvedValue(noGates);
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the stats page', () => {
    it('shows the totals, the stages and the top cards, and links from the header', async () => {
        vi.spyOn(BoardClient.prototype, 'getProjectStats').mockResolvedValue(stats);

        renderApp();

        expect(await screen.findByText('12.3K')).toBeTruthy();
        expect(screen.getByText('75% cached')).toBeTruthy();
        expect(screen.getByText('3 of 4 attempts')).toBeTruthy();
        expect(screen.getByText('2.0 attempts each, 1 interrupted')).toBeTruthy();
        expect(screen.getByText('implementing')).toBeTruthy();
        expect(screen.getByText('67%')).toBeTruthy();
        expect(screen.getByRole('link', { name: '0001 Ship it' }).getAttribute('href')).toBe('/projects/demo/cards/0001');
        expect(screen.getByText('0002 (no longer on the board)')).toBeTruthy();
        expect(screen.getByText(/America\/New_York/)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Stats' }).getAttribute('href')).toBe('/projects/demo/stats');
    });

    it('does not count a revise as a passed attempt, in the tile or in its stage', async () => {
        vi.spyOn(BoardClient.prototype, 'getProjectStats').mockResolvedValue(stats);
        vi.spyOn(BoardClient.prototype, 'getProjectGateStats').mockResolvedValue({ ...noGates, revised: [{ stage: 'review', count: 1 }] });

        renderApp();

        expect(await screen.findByText('2 of 4 attempts, 1 asked for changes')).toBeTruthy();
        expect(screen.getAllByText('50%')).toHaveLength(1);
        expect(screen.getByText('0%')).toBeTruthy();
    });

    it('shows what the gates caught, labelling what older events were matched by text', async () => {
        vi.spyOn(BoardClient.prototype, 'getProjectStats').mockResolvedValue(stats);
        vi.spyOn(BoardClient.prototype, 'getProjectGateStats').mockResolvedValue({
            ...noGates,
            kickbacks: [
                { stage: 'review', reason: 'revise', count: 2, matched: 0 },
                { stage: 'review', step: 'challenge', reason: 'revise', count: 1, matched: 0 },
                { stage: 'testing', reason: 'verifier', count: 3, matched: 1 },
            ],
            failures: [{ failureClass: 'budget', count: 4, matched: 2 }],
            challenge: { upheld: 1, overturned: 2 },
            questions: { asked: 3, answered: 1 },
            rules: [{ rule: 'r1', statement: 'No secrets in logs', failed: 2, unavailable: 1 }],
            loopStops: 5,
            touchpoints: [{ cause: 'question', count: 3 }],
            firstPass: { reached: 5, firstPass: 3 },
            matched: 3,
            difficulties: [{ cardId: '0042', stage: 'testing', note: 'suite takes nine minutes', at: stats.until }],
        });

        renderApp();

        expect(await screen.findByText('3 of 5 cards reaching ready, no retries spent')).toBeTruthy();
        expect(screen.getByText('60%')).toBeTruthy();
        expect(screen.getByText('challenge upheld 1, overturned 2')).toBeTruthy();
        expect(screen.getByText('3 questions, 1 answered')).toBeTruthy();
        expect(screen.getByText('Asked for changes')).toBeTruthy();
        expect(screen.getByText('Challenge upheld a revise')).toBeTruthy();
        expect(screen.getByText('3 (1 matched)')).toBeTruthy();
        expect(screen.getByText('Ran out of budget')).toBeTruthy();
        expect(screen.getByText('4 (2 matched)')).toBeTruthy();
        expect(screen.getByText('Asked a question')).toBeTruthy();
        expect(screen.getByText('No secrets in logs')).toBeTruthy();
        expect(screen.getByText(/3 older failed attempts do not say why/)).toBeTruthy();
        expect(screen.getByText('suite takes nine minutes')).toBeTruthy();
    });

    it('keeps planning and review in a table of their own, beside the stage total', async () => {
        vi.spyOn(BoardClient.prototype, 'getProjectStats').mockResolvedValue(stats);

        renderApp();

        expect(await screen.findByText('12.3K')).toBeTruthy();
        expect(screen.getByText('plus 3.5K in planning and review')).toBeTruthy();
        expect(screen.getByText('Planning')).toBeTruthy();
        expect(screen.getByText('60,000')).toBeTruthy();
        expect(screen.getByText('Review')).toBeTruthy();
    });

    it('still shows a project that has only talked, with no stage run', async () => {
        vi.spyOn(BoardClient.prototype, 'getProjectStats').mockResolvedValue({
            ...stats,
            total: { ...counts(), cards: 0 },
            stages: [],
            topCards: [],
        });

        renderApp();

        expect(await screen.findByText('Planning and review')).toBeTruthy();
        expect(screen.queryByText(/NaN/)).toBeNull();
    });

    it('draws a bar only for a day with tokens, sized against the axis', async () => {
        vi.spyOn(BoardClient.prototype, 'getProjectStats').mockResolvedValue(stats);

        renderApp();

        const busy = await screen.findByTestId('day-2026-01-13');
        expect((busy.firstElementChild as HTMLElement).style.height).toBe(`${(12_345 / 20_000) * 100}%`);
        expect(screen.getByTestId('day-2026-01-14').firstElementChild).toBeNull();
    });

    it('swaps the chart for a table of every day', async () => {
        vi.spyOn(BoardClient.prototype, 'getProjectStats').mockResolvedValue(stats);

        renderApp();
        fireEvent.click(await screen.findByRole('button', { name: 'Show as table' }));

        expect(screen.getByText('13 Jan')).toBeTruthy();
        expect(screen.getByText('14 Jan')).toBeTruthy();
        expect(screen.queryByRole('img', { name: /Output tokens per day/ })).toBeNull();
    });

    it('reads thirty days first, and another window when asked', async () => {
        const read = vi.spyOn(BoardClient.prototype, 'getProjectStats').mockResolvedValue(stats);

        renderApp();
        await screen.findByText('12.3K');
        expect(read).toHaveBeenCalledWith({ days: 30 });

        fireEvent.click(screen.getByText('7 days'));

        await waitFor(() => expect(read).toHaveBeenCalledWith({ days: 7 }));
    });

    it('says so when nothing has run', async () => {
        vi.spyOn(BoardClient.prototype, 'getProjectStats').mockResolvedValue({
            ...stats,
            total: { ...counts(), cards: 0 },
            stages: [],
            topCards: [],
            conversations: [],
        });

        renderApp();

        expect(await screen.findByText('Nothing has run in this window.')).toBeTruthy();
    });

    it('reads again when a card event arrives', async () => {
        const read = vi.spyOn(BoardClient.prototype, 'getProjectStats').mockResolvedValue(stats);

        renderApp();
        await screen.findByText('12.3K');
        await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
        const calls = read.mock.calls.length;

        FakeEventSource.instances[FakeEventSource.instances.length - 1]!.emit({ id: 9, cardId: '0001', stage: 'review', type: 'stage.passed' });

        await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(calls));
    });
});
