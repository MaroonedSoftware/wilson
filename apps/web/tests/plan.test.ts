// @vitest-environment jsdom
//
// Card 0137's `lib/plan.ts` is new: `usePlanTranscript` subscribes to a card's planning
// conversation over `GET /api/cards/:id/plan/stream`, following `useCardFeed`'s own approach
// (`feed.test.ts`) closely enough to reuse its FakeEventSource stand-in for jsdom's missing
// `EventSource`. This file covers the hook directly — turn/delta merging, seq dedupe and
// ordering, the enabled flag, the never-opened-vs-transient-drop error rule, and commitTurn — in
// isolation from the component that renders it (planning-session.test.ts covers that).
//
// Card 0138 adds `usePlanDraft` to this same file: a plain polling `useQuery` over
// `GET .../plan/draft`. Covered here directly — the endpoint it calls, the query key
// `DraftPane.tsx` relies on to read and to seed via `queryClient`, the `enabled` gate, and that it
// polls rather than pushes.
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanComment, PlanTurn } from '@wilson/sdk';
import { usePlanComments, usePlanDraft, usePlanTranscript } from '#src/lib/plan.js';
import { API_BASE, wilson } from '#src/lib/sdk.js';

/** Same stand-in `feed.test.ts` uses for jsdom's missing `EventSource`: records what the hook
 * does to it and lets a test drive `onopen`/`onerror`/named events exactly as the browser would. */
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

    emit(type: string, data = '') {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(new MessageEvent(type, { data }));
        }
    }
}

const latestSource = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

const turn = (seq: number, overrides: Partial<PlanTurn> = {}): PlanTurn => ({
    seq,
    role: 'assistant',
    content: `turn ${seq}`,
    createdAt: '2026-08-27T00:00:00.000Z',
    ...overrides,
});

beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('usePlanTranscript', () => {
    it('opens a stream against the card-scoped endpoint when enabled', () => {
        renderHook(() => usePlanTranscript('0007', true));

        expect(FakeEventSource.instances).toHaveLength(1);
        expect(latestSource().url).toBe(`${API_BASE}/api/cards/0007/plan/stream`);
    });

    it('does not open a stream while disabled, so a non-planning stage never subscribes', () => {
        renderHook(() => usePlanTranscript('0007', false));

        expect(FakeEventSource.instances).toHaveLength(0);
    });

    it('starts connecting and flips to live once the stream opens', () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        expect(result.current.status).toBe('connecting');

        act(() => latestSource().onopen?.());

        expect(result.current.status).toBe('live');
    });

    it('concatenates delta chunks in arrival order for the turn still being written', () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        act(() => latestSource().onopen?.());

        act(() => latestSource().emit('delta', 'Hel'));
        act(() => latestSource().emit('delta', 'lo'));

        expect(result.current.pendingText).toBe('Hello');
    });

    it('appends a replayed turn and clears the pending text it supersedes', () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        act(() => latestSource().onopen?.());
        act(() => latestSource().emit('delta', 'partial reply'));
        expect(result.current.pendingText).toBe('partial reply');

        act(() => latestSource().emit('turn', JSON.stringify(turn(1, { content: 'the finished reply' }))));

        expect(result.current.turns).toEqual([turn(1, { content: 'the finished reply' })]);
        expect(result.current.pendingText).toBe('');
    });

    it('dedupes a re-replayed turn by seq instead of appending it twice', () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        act(() => latestSource().onopen?.());

        act(() => latestSource().emit('turn', JSON.stringify(turn(1))));
        act(() => latestSource().emit('turn', JSON.stringify(turn(1))));

        expect(result.current.turns).toHaveLength(1);
    });

    it('keeps turns ordered by seq even when they arrive out of order', () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        act(() => latestSource().onopen?.());

        act(() => latestSource().emit('turn', JSON.stringify(turn(2))));
        act(() => latestSource().emit('turn', JSON.stringify(turn(1))));

        expect(result.current.turns.map(t => t.seq)).toEqual([1, 2]);
    });

    it('reports an error only once the stream fails without ever having opened', () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));

        act(() => latestSource().onerror?.());

        expect(result.current.status).toBe('disconnected');
        expect(result.current.error).toBe('Could not connect to the planning conversation.');
    });

    it('does not surface an error for a transient drop after the stream has already opened once', () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        act(() => latestSource().onopen?.());

        act(() => latestSource().onerror?.());

        expect(result.current.status).toBe('disconnected');
        expect(result.current.error).toBeUndefined();
    });

    it("recovers to live once the browser's own retry reopens the connection", () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        act(() => latestSource().onopen?.());
        act(() => latestSource().onerror?.());

        act(() => latestSource().onopen?.());

        expect(result.current.status).toBe('live');
    });

    it("folds a directly-returned turn into the transcript via commitTurn, the sender's own path", () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        act(() => latestSource().onopen?.());
        act(() => latestSource().emit('delta', 'still typing'));

        act(() => result.current.commitTurn(turn(1, { role: 'user', content: 'hello' })));

        expect(result.current.turns).toEqual([turn(1, { role: 'user', content: 'hello' })]);
        expect(result.current.pendingText).toBe('');
    });

    it('closes the previous stream and starts a fresh, empty transcript when the card id changes', () => {
        const { result, rerender } = renderHook(({ cardId }) => usePlanTranscript(cardId, true), {
            initialProps: { cardId: '0007' },
        });
        act(() => latestSource().onopen?.());
        act(() => latestSource().emit('turn', JSON.stringify(turn(1))));
        expect(result.current.turns).toHaveLength(1);
        const first = latestSource();

        rerender({ cardId: '0008' });

        expect(first.closed).toBe(true);
        expect(FakeEventSource.instances).toHaveLength(2);
        expect(latestSource().url).toBe(`${API_BASE}/api/cards/0008/plan/stream`);
        // Never carried across the remount by component state — rebuilt entirely from what the new
        // connection replays, so a stale reducer from card 0007 can't leak into card 0008's view.
        expect(result.current.turns).toEqual([]);
        expect(result.current.status).toBe('connecting');
    });

    it('closes the source on unmount instead of leaking an open connection', () => {
        const { unmount } = renderHook(() => usePlanTranscript('0007', true));
        const source = latestSource();

        expect(source.closed).toBe(false);
        unmount();
        expect(source.closed).toBe(true);
    });

    // Card 0153: `EventSource` cannot set `X-Wilson-Project`, so this stream names itself with
    // `?project=` instead, the same query fallback `useCardFeed` uses for `/api/feed` and
    // `routes.setup.ts`'s `ProjectContextRouter` now accepts on both streams.
    it('names the project as a ?project= query parameter when one is given', () => {
        renderHook(() => usePlanTranscript('0007', true, 'demo-project'));

        expect(latestSource().url).toBe(`${API_BASE}/api/cards/0007/plan/stream?project=demo-project`);
    });

    it('still opens against the plain per-card endpoint, with no query at all, when no project is given', () => {
        renderHook(() => usePlanTranscript('0007', true));

        expect(latestSource().url).toBe(`${API_BASE}/api/cards/0007/plan/stream`);
    });

    it('closes the previous stream and opens a fresh one naming the new project when the project changes', () => {
        const { rerender } = renderHook(({ project }: { project?: string }) => usePlanTranscript('0007', true, project), {
            initialProps: { project: 'first-project' },
        });
        const first = latestSource();
        expect(first.url).toBe(`${API_BASE}/api/cards/0007/plan/stream?project=first-project`);

        rerender({ project: 'second-project' });

        expect(first.closed).toBe(true);
        expect(FakeEventSource.instances).toHaveLength(2);
        expect(latestSource().url).toBe(`${API_BASE}/api/cards/0007/plan/stream?project=second-project`);
    });
});

const withQueryClient = (queryClient: QueryClient) => {
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
    return wrapper;
};

describe('usePlanDraft', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('fetches the card-scoped draft endpoint through the SDK when enabled', async () => {
        const getAPlanDraft = vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'draft text' });
        const queryClient = new QueryClient();

        const { result } = renderHook(() => usePlanDraft('0007', true), { wrapper: withQueryClient(queryClient) });

        await waitFor(() => expect(result.current.data).toEqual({ body: 'draft text' }));
        expect(getAPlanDraft).toHaveBeenCalledWith('0007');
    });

    it('does not fetch while disabled, so a non-planning stage never polls', () => {
        const getAPlanDraft = vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: '' });
        const queryClient = new QueryClient();

        renderHook(() => usePlanDraft('0007', false), { wrapper: withQueryClient(queryClient) });

        expect(getAPlanDraft).not.toHaveBeenCalled();
    });

    it('renders an empty draft as an ordinary result rather than an error, for a card with no draft yet', async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: '' });
        const queryClient = new QueryClient();

        const { result } = renderHook(() => usePlanDraft('0007', true), { wrapper: withQueryClient(queryClient) });

        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data?.body).toBe('');
        expect(result.current.error).toBeNull();
    });

    it("keys its cache entry under ['plan-draft', cardId], the key DraftPane relies on to seed its own baseline", async () => {
        vi.spyOn(wilson.board, 'getAPlanDraft').mockResolvedValue({ body: 'seeded' });
        const queryClient = new QueryClient();

        renderHook(() => usePlanDraft('0009', true), { wrapper: withQueryClient(queryClient) });

        await waitFor(() => expect(queryClient.getQueryData(['plan-draft', '0009'])).toEqual({ body: 'seeded' }));
    });
});

describe('usePlanComments', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const comment = (overrides: Partial<PlanComment> = {}): PlanComment => ({
        id: 'c1',
        quote: 'brown fox',
        prefix: 'the quick ',
        suffix: ' jumps',
        text: 'nice catch',
        resolved: false,
        createdAt: '2026-08-27T00:00:00.000Z',
        ...overrides,
    });

    it('fetches the card-scoped comments endpoint through the SDK when enabled', async () => {
        const listPlanComments = vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([comment()]);
        const queryClient = new QueryClient();

        const { result } = renderHook(() => usePlanComments('0007', true), { wrapper: withQueryClient(queryClient) });

        await waitFor(() => expect(result.current.data).toEqual([comment()]));
        expect(listPlanComments).toHaveBeenCalledWith('0007');
    });

    it('does not fetch while disabled, so a non-planning stage never requests comments', () => {
        const listPlanComments = vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([]);
        const queryClient = new QueryClient();

        renderHook(() => usePlanComments('0007', false), { wrapper: withQueryClient(queryClient) });

        expect(listPlanComments).not.toHaveBeenCalled();
    });

    it("keys its cache entry under ['plan-comments', cardId] — the key useAddPlanComment/useResolvePlanComment invalidate on success", async () => {
        vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([comment()]);
        const queryClient = new QueryClient();

        renderHook(() => usePlanComments('0009', true), { wrapper: withQueryClient(queryClient) });

        await waitFor(() => expect(queryClient.getQueryData(['plan-comments', '0009'])).toEqual([comment()]));
    });

    it('returns both resolved and open comments — resolving is a state, not a filter', async () => {
        vi.spyOn(wilson.board, 'listPlanComments').mockResolvedValue([comment({ id: 'c1', resolved: false }), comment({ id: 'c2', resolved: true })]);
        const queryClient = new QueryClient();

        const { result } = renderHook(() => usePlanComments('0007', true), { wrapper: withQueryClient(queryClient) });

        await waitFor(() => expect(result.current.data).toHaveLength(2));
        expect(result.current.data?.map(c => c.resolved)).toEqual([false, true]);
    });
});
