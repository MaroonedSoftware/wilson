// @vitest-environment jsdom
//
// Card 0137's `lib/plan.ts` is new: `usePlanTranscript` subscribes to a card's planning stream and
// folds the two SSE events it can see (`turn`, `delta`) — plus a sender's own `commitTurn` — into a
// transcript. These tests drive the hook directly with a fake `EventSource`, following
// feed.mount.test.ts's approach for `useCardFeed`, in isolation from the component that renders it
// (planning-session.test.ts covers that wiring).
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanTurn } from '@wilson/sdk';
import { usePlanTranscript } from '#src/lib/plan.js';

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

beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const turn = (seq: number, role: PlanTurn['role'], content: string): PlanTurn => ({
    seq,
    role,
    content,
    createdAt: '2026-08-27T00:00:00.000Z',
});

describe('usePlanTranscript', () => {
    it('does not open a connection while disabled', () => {
        renderHook(() => usePlanTranscript('0007', false));
        expect(FakeEventSource.instances).toHaveLength(0);
    });

    it('opens the stream at the card-scoped URL once enabled', () => {
        renderHook(() => usePlanTranscript('0007', true));
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(FakeEventSource.instances[0].url).toContain('/api/cards/0007/plan/stream');
    });

    it('assembles replayed turn events into an ordered, deduplicated transcript', () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        const source = FakeEventSource.instances[0];

        act(() => {
            source.emit('turn', JSON.stringify(turn(2, 'assistant', 'second')));
            source.emit('turn', JSON.stringify(turn(1, 'user', 'first')));
            // A replay can hand back the same row twice (e.g. an overlapping Last-Event-ID window) —
            // it must not appear twice in the transcript.
            source.emit('turn', JSON.stringify(turn(2, 'assistant', 'second')));
        });

        expect(result.current.turns.map(t => t.seq)).toEqual([1, 2]);
    });

    it('accumulates delta chunks into pendingText and clears it once the matching turn event lands', () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        const source = FakeEventSource.instances[0];

        act(() => source.emit('delta', 'Hel'));
        act(() => source.emit('delta', 'lo'));
        expect(result.current.pendingText).toBe('Hello');
        expect(result.current.turns).toEqual([]);

        act(() => source.emit('turn', JSON.stringify(turn(1, 'assistant', 'Hello'))));

        expect(result.current.pendingText).toBe('');
        expect(result.current.turns).toEqual([turn(1, 'assistant', 'Hello')]);
    });

    it("commitTurn folds the sender's own reply straight in, without waiting for a replay", () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        const source = FakeEventSource.instances[0];
        act(() => source.emit('delta', 'partial'));

        act(() => result.current.commitTurn(turn(1, 'assistant', 'the whole reply')));

        expect(result.current.turns).toEqual([turn(1, 'assistant', 'the whole reply')]);
        expect(result.current.pendingText).toBe('');
    });

    it('reports an error only once the stream has failed without ever having opened', () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        const source = FakeEventSource.instances[0];

        act(() => source.onerror?.());

        expect(result.current.status).toBe('disconnected');
        expect(result.current.error).toBe('Could not connect to the planning conversation.');
    });

    it('does not surface an error for a drop after the stream had already opened once', () => {
        const { result } = renderHook(() => usePlanTranscript('0007', true));
        const source = FakeEventSource.instances[0];

        act(() => source.onopen?.());
        expect(result.current.status).toBe('live');

        act(() => source.onerror?.());

        expect(result.current.status).toBe('disconnected');
        expect(result.current.error).toBeUndefined();
    });

    it('closes the old connection and starts over empty — not the stale transcript — when the card id changes', () => {
        const { result, rerender } = renderHook(({ cardId }) => usePlanTranscript(cardId, true), {
            initialProps: { cardId: '0007' },
        });
        const first = FakeEventSource.instances[0];
        act(() => first.emit('turn', JSON.stringify(turn(1, 'user', 'about card 0007'))));
        expect(result.current.turns).toHaveLength(1);

        rerender({ cardId: '0009' });

        expect(first.closed).toBe(true);
        expect(FakeEventSource.instances).toHaveLength(2);
        expect(FakeEventSource.instances[1].url).toContain('/api/cards/0009/plan/stream');
        expect(result.current.turns).toEqual([]);
        expect(result.current.pendingText).toBe('');
        expect(result.current.status).toBe('connecting');
    });

    it('closes the connection on unmount', () => {
        const { unmount } = renderHook(() => usePlanTranscript('0007', true));
        const source = FakeEventSource.instances[0];

        unmount();

        expect(source.closed).toBe(true);
    });
});
