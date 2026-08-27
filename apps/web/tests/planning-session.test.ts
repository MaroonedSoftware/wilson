// @vitest-environment jsdom
//
// Card 0137: `PlanningSession.tsx` and the `planning`-only branch it adds to `CardDetail.tsx`. These
// render the real route tree at `/cards/$cardId` (the same approach card-detail.actions.test.ts
// takes) with `wilson`'s SDK calls mocked and `EventSource` faked, so the stage gating, the
// incremental streaming, and the inline-failure rules are all exercised as actually written rather
// than through a stand-in.
//
// Files are `.test.ts`, not `.test.tsx`, to match `apps/web/vitest.config.ts`'s
// `include: ['./tests/**/*.test.ts']` — JSX is written via `createElement` instead.
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SdkError } from '@wilson/sdk';
import type { BoardColumns, CardDetail, PlanSession, PlanTurn } from '@wilson/sdk';
import { wilson } from '#src/lib/sdk.js';
import { routeTree } from '#src/routeTree.gen.js';

const columns: BoardColumns = {
    stages: ['planning', 'implementing', 'testing'],
    nonStages: ['parking-lot', 'merged'],
};

const card = (stage: string): CardDetail => ({
    id: '0007',
    title: 'Do the thing',
    stage,
    dependsOn: [],
    needsHuman: false,
    sections: {},
    body: 'the plan body, read-only',
});

const planSession: PlanSession = {
    sessionId: 'sess-1',
    worktreePath: '/tmp/0007',
    draftPath: '/tmp/0007/PLAN.md',
    model: 'test-model',
    instructions: 'be helpful',
};

const turn = (seq: number, role: PlanTurn['role'], content: string): PlanTurn => ({
    seq,
    role,
    content,
    createdAt: '2026-08-27T00:00:00.000Z',
});

/**
 * A fake `EventSource` that actually tracks listeners and lets a test target either connection this
 * page can open at once — the root layout's `/api/feed` (`useCardFeed`, mounted regardless of what
 * route renders) and, for a `planning` card, `PlanningSessionPane`'s own `/plan/stream` — by URL.
 */
class FakeEventSource {
    static instances: FakeEventSource[] = [];

    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

    constructor(public readonly url: string) {
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

    emit(type: string, data = '') {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(new MessageEvent(type, { data }));
        }
    }
}

const planStream = () => FakeEventSource.instances.find(instance => instance.url.includes('/plan/stream'));

/**
 * `AppShell.Main` renders inside Mantine's `ScrollArea`, which measures itself with
 * `ResizeObserver` on mount — jsdom does not implement it. Same stand-in card-detail.actions.test.ts
 * uses.
 */
class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function renderApp(path: string) {
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
    // Retries off: react-query's default backoff (three retries, growing delays) would otherwise
    // make a rejected `openAPlanningSession` query take several real seconds to surface here.
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
    vi.spyOn(wilson.board, 'listCardEvents').mockResolvedValue([]);
    vi.spyOn(wilson.board, 'listCardVersions').mockResolvedValue([]);
    vi.spyOn(wilson.board, 'listBoardColumns').mockResolvedValue(columns);
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    Element.prototype.scrollIntoView = vi.fn();

    // jsdom does not implement matchMedia; MantineProvider reads it on mount, and so does
    // `PlanningPanes`'s own `useMediaQuery` — stubbed to always report "not narrow" so both `planning`
    // panes render side by side (`Grid`) rather than behind `Tabs`, matching every assertion below.
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
    FakeEventSource.instances = [];
});

describe('a card outside planning', () => {
    it('renders exactly as before — no session UI, and no stream opened', async () => {
        vi.spyOn(wilson.board, 'getCard').mockResolvedValue(card('implementing'));
        const openSession = vi.spyOn(wilson.board, 'openAPlanningSession');

        renderApp('/cards/0007');
        await screen.findByText('Do the thing');
        // The read-only body still renders — just not behind the two-pane session.
        await screen.findByText('the plan body, read-only');

        expect(screen.queryByText('Conversation')).toBeNull();
        expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
        expect(openSession).not.toHaveBeenCalled();
        expect(planStream()).toBeUndefined();
    });
});

describe('a card in planning', () => {
    it('renders the two-pane session — conversation beside the read-only current body', async () => {
        vi.spyOn(wilson.board, 'getCard').mockResolvedValue(card('planning'));
        vi.spyOn(wilson.board, 'openAPlanningSession').mockResolvedValue(planSession);

        renderApp('/cards/0007');
        await screen.findByText('Do the thing');

        expect(await screen.findByText('Conversation')).toBeTruthy();
        // The draft pane this card leaves as a placeholder for [[0138]]: the card's real body,
        // rendered read-only, with no editing control anywhere near it.
        expect(await screen.findByText('the plan body, read-only')).toBeTruthy();
        expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
        expect(await screen.findByText('No turns yet — start the conversation below.')).toBeTruthy();
    });

    it('shows replayed turns instead of leaving the pane blank', async () => {
        vi.spyOn(wilson.board, 'getCard').mockResolvedValue(card('planning'));
        vi.spyOn(wilson.board, 'openAPlanningSession').mockResolvedValue(planSession);

        renderApp('/cards/0007');
        await screen.findByText('Do the thing');
        const stream = planStream();
        if (!stream) throw new Error('expected the plan stream to have opened');

        act(() => {
            stream.emit('turn', JSON.stringify(turn(1, 'user', 'What should the API look like?')));
            stream.emit('turn', JSON.stringify(turn(2, 'assistant', 'Here is a sketch.')));
        });

        expect(await screen.findByText('What should the API look like?')).toBeTruthy();
        expect(await screen.findByText('Here is a sketch.')).toBeTruthy();
        expect(screen.queryByText('No turns yet — start the conversation below.')).toBeNull();
    });

    it('shows an inline reason when the stream never opens, rather than a blank pane', async () => {
        vi.spyOn(wilson.board, 'getCard').mockResolvedValue(card('planning'));
        vi.spyOn(wilson.board, 'openAPlanningSession').mockResolvedValue(planSession);

        renderApp('/cards/0007');
        await screen.findByText('Do the thing');
        const stream = planStream();
        if (!stream) throw new Error('expected the plan stream to have opened');

        act(() => stream.onerror?.());

        expect(await screen.findByText('Could not connect to the planning conversation.')).toBeTruthy();
    });

    it('shows the reason a session failed to open, inline, and keeps the composer disabled', async () => {
        vi.spyOn(wilson.board, 'getCard').mockResolvedValue(card('planning'));
        vi.spyOn(wilson.board, 'openAPlanningSession').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'card 0007 already has work on its branch' } },
                new Headers(),
            ),
        );

        renderApp('/cards/0007');
        await screen.findByText('Do the thing');

        expect(await screen.findByText('card 0007 already has work on its branch')).toBeTruthy();
        const textbox = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
        expect(textbox.disabled).toBe(true);
    });

    it("sends a turn, echoes it immediately, and streams the assistant's reply in before the request completes", async () => {
        vi.spyOn(wilson.board, 'getCard').mockResolvedValue(card('planning'));
        vi.spyOn(wilson.board, 'openAPlanningSession').mockResolvedValue(planSession);
        let resolveSend: ((turn: PlanTurn) => void) | undefined;
        const sendTurn = vi.spyOn(wilson.board, 'sendAPlanTurn').mockImplementation(
            () =>
                new Promise<PlanTurn>(resolve => {
                    resolveSend = resolve;
                }),
        );

        renderApp('/cards/0007');
        await screen.findByText('Do the thing');
        const textbox = await screen.findByRole('textbox', { name: 'Message' });
        const send = screen.getByRole('button', { name: 'Send' });

        fireEvent.change(textbox, { target: { value: 'What should the API look like?' } });
        await act(async () => {
            fireEvent.click(send);
        });

        expect(sendTurn).toHaveBeenCalledWith('0007', { text: 'What should the API look like?' });
        // Echoed the moment it is sent — no round trip needed to see what was just typed.
        expect(await screen.findByText('What should the API look like?')).toBeTruthy();

        // The server is still writing the reply; this pane learns it the same way any other open tab
        // would, over the stream, not from the still-pending POST.
        const stream = planStream();
        if (!stream) throw new Error('expected the plan stream to have opened');
        act(() => stream.emit('delta', 'Here is'));
        expect(await screen.findByText('Here is')).toBeTruthy();
        act(() => stream.emit('delta', ' a sketch.'));
        expect(await screen.findByText('Here is a sketch.')).toBeTruthy();

        // Only once the POST itself resolves does the reply become a real, persisted turn.
        await act(async () => {
            resolveSend?.(turn(2, 'assistant', 'Here is a sketch.'));
        });

        expect(await screen.findByText('Here is a sketch.')).toBeTruthy();
    });

    it("shows the server's own refusal sentence inline, not a generic message", async () => {
        vi.spyOn(wilson.board, 'getCard').mockResolvedValue(card('planning'));
        vi.spyOn(wilson.board, 'openAPlanningSession').mockResolvedValue(planSession);
        vi.spyOn(wilson.board, 'sendAPlanTurn').mockRejectedValue(
            new SdkError(
                400,
                'Bad Request',
                { statusCode: 400, message: 'Bad Request', details: { reason: 'this session has already been closed' } },
                new Headers(),
            ),
        );

        renderApp('/cards/0007');
        await screen.findByText('Do the thing');
        const textbox = await screen.findByRole('textbox', { name: 'Message' });
        const send = screen.getByRole('button', { name: 'Send' });

        fireEvent.change(textbox, { target: { value: 'one more thing' } });
        await act(async () => {
            fireEvent.click(send);
        });

        expect(await screen.findByText('this session has already been closed')).toBeTruthy();
        expect(screen.queryByText('400 Bad Request')).toBeNull();
    });
});
