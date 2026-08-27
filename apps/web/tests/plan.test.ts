// @vitest-environment jsdom
//
// Card 0137's `lib/plan.ts` is new: `usePlanTranscript` subscribes to a card's planning
// conversation over `GET /api/cards/:id/plan/stream`, following `useCardFeed`'s own approach
// (`feed.test.ts`) closely enough to reuse its FakeEventSource stand-in for jsdom's missing
// `EventSource`. This file covers the hook directly — turn/delta merging, seq dedupe and
// ordering, the enabled flag, the never-opened-vs-transient-drop error rule, and commitTurn — in
// isolation from the component that renders it (planning-session.test.ts covers that).
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanTurn } from '@wilson/sdk';
import { usePlanTranscript } from '#src/lib/plan.js';
import { API_BASE } from '#src/lib/sdk.js';

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
});
