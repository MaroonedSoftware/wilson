// @vitest-environment jsdom
//
// Card 0274: `useCardFeed` gains `activity` (the latest feed event per card), `toolLog` (each card's
// own recent `tool.*` history) and `now` (the one shared ticking clock), plus a behaviour change to
// its existing `card`-event invalidation — a `tool.executed`/`tool.denied`/`tool.unguarded` event no
// longer invalidates the `['cards']` query (AC1). None of `activity`/`toolLog`/`now`/`MAX_LIVE_TOOL_EVENTS`
// exist on the pre-change tree, and the pre-change hook invalidated on every card event regardless of
// its type — every test below fails to even import, or fails its assertion, there. Reuses `feed.test.ts`'s
// own `FakeEventSource` stand-in and `renderFeed` shape.
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_LIVE_TOOL_EVENTS, useCardFeed } from '#src/lib/feed.js';

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

    emit(type: string, data = '{}') {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(new MessageEvent(type, { data }));
        }
    }
}

const latestSource = () => FakeEventSource.instances[FakeEventSource.instances.length - 1]!;

/** Builds the JSON text a `card` SSE event actually carries (`card.feed.listener.ts`'s own shape:
 * `{ id, ts, message, correlationId, data: { stage, payload } }`) — see `feed.ts`'s `WireCardEvent`. */
const wireEvent = ({
    id = 1,
    ts = '2026-01-10T12:00:00.000Z',
    message = 'stage.dispatched',
    correlationId = '0043',
    stage = 'testing',
    payload = null,
}: {
    id?: number;
    ts?: string;
    message?: string;
    correlationId?: string | null;
    stage?: string | null;
    payload?: unknown;
} = {}) => JSON.stringify({ id, ts, message, correlationId, data: { stage, payload } });

beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

const renderFeed = (project?: string) => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
    const hook = renderHook(({ project: p }: { project?: string }) => useCardFeed(p), { wrapper, initialProps: { project } });
    return { ...hook, invalidateQueries };
};

describe('useCardFeed activity', () => {
    it('records the latest feed event for a card under its own id', () => {
        const { result } = renderFeed();

        act(() =>
            latestSource().emit('card', wireEvent({ correlationId: '0043', message: 'stage.dispatched', stage: 'testing', payload: { note: 'x' } })),
        );

        expect(result.current.activity['0043']).toEqual({
            type: 'stage.dispatched',
            stage: 'testing',
            payload: { note: 'x' },
            ts: '2026-01-10T12:00:00.000Z',
        });
    });

    it("overwrites a card's activity with a newer event rather than keeping the first", () => {
        const { result } = renderFeed();

        act(() => latestSource().emit('card', wireEvent({ correlationId: '0043', message: 'stage.dispatched', ts: '2026-01-10T12:00:00.000Z' })));
        act(() => latestSource().emit('card', wireEvent({ correlationId: '0043', message: 'tool.executed', ts: '2026-01-10T12:01:00.000Z' })));

        expect(result.current.activity['0043']).toEqual(expect.objectContaining({ type: 'tool.executed', ts: '2026-01-10T12:01:00.000Z' }));
    });

    it("keeps two different cards' activity independent", () => {
        const { result } = renderFeed();

        act(() => latestSource().emit('card', wireEvent({ correlationId: '0001', message: 'stage.dispatched' })));
        act(() => latestSource().emit('card', wireEvent({ correlationId: '0002', message: 'tool.executed' })));

        expect(result.current.activity['0001']!.type).toBe('stage.dispatched');
        expect(result.current.activity['0002']!.type).toBe('tool.executed');
    });

    it('records nothing for a card event with no correlationId, rather than crashing', () => {
        const { result } = renderFeed();

        expect(() => act(() => latestSource().emit('card', wireEvent({ correlationId: null })))).not.toThrow();
        expect(result.current.activity).toEqual({});
    });

    it('ignores a card event whose data is not valid JSON, rather than throwing', () => {
        const { result } = renderFeed();

        expect(() => act(() => latestSource().emit('card', 'not json'))).not.toThrow();
        expect(result.current.activity).toEqual({});
    });
});

// AC1: an exclusion list, not an allow list — a `tool.*` event stops invalidating, and every other
// event type (existing or invented later) still does.
describe('useCardFeed invalidation exclusion (AC1)', () => {
    it.each(['tool.executed', 'tool.denied', 'tool.unguarded'])('does not invalidate the cards query for a %s event', message => {
        const { invalidateQueries } = renderFeed();

        act(() => latestSource().emit('card', wireEvent({ message })));

        expect(invalidateQueries).not.toHaveBeenCalled();
    });

    it('still invalidates the cards query for stage.dispatched', () => {
        const { invalidateQueries } = renderFeed();

        act(() => latestSource().emit('card', wireEvent({ message: 'stage.dispatched' })));

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['cards'] });
    });

    it('still invalidates for an event type outside the exclusion list, proving the rule excludes rather than allows', () => {
        const { invalidateQueries } = renderFeed();

        act(() => latestSource().emit('card', wireEvent({ message: 'some.future.event.type' })));

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['cards'] });
    });

    it('still records the event in activity even though it does not invalidate', () => {
        const { result } = renderFeed();

        act(() => latestSource().emit('card', wireEvent({ correlationId: '0043', message: 'tool.denied' })));

        expect(result.current.activity['0043']!.type).toBe('tool.denied');
    });
});

describe('useCardFeed toolLog', () => {
    it("keeps a card's own tool.* history newest first", () => {
        const { result } = renderFeed();

        act(() => latestSource().emit('card', wireEvent({ id: 1, correlationId: '0043', message: 'tool.executed', ts: '2026-01-10T12:00:00.000Z' })));
        act(() => latestSource().emit('card', wireEvent({ id: 2, correlationId: '0043', message: 'tool.denied', ts: '2026-01-10T12:01:00.000Z' })));

        expect(result.current.toolLog['0043']!.map(event => event.type)).toEqual(['tool.denied', 'tool.executed']);
    });

    it('does not add a non-tool event to the tool log', () => {
        const { result } = renderFeed();

        act(() => latestSource().emit('card', wireEvent({ correlationId: '0043', message: 'stage.dispatched' })));

        expect(result.current.toolLog['0043']).toBeUndefined();
    });

    it("caps a card's tool history at MAX_LIVE_TOOL_EVENTS, dropping the oldest", () => {
        const { result } = renderFeed();

        for (let i = 0; i < MAX_LIVE_TOOL_EVENTS + 5; i++) {
            act(() =>
                latestSource().emit(
                    'card',
                    wireEvent({ id: i, correlationId: '0043', message: 'tool.executed', ts: `2026-01-10T12:${String(i).padStart(2, '0')}:00.000Z` }),
                ),
            );
        }

        const log = result.current.toolLog['0043']!;
        expect(log).toHaveLength(MAX_LIVE_TOOL_EVENTS);
        // Newest first: the very last event emitted (id MAX_LIVE_TOOL_EVENTS + 4) is still present at
        // the front; the oldest ones (id 0..4) were dropped off the end.
        expect(log[0]!.id).toBe(MAX_LIVE_TOOL_EVENTS + 4);
        expect(log.map(event => event.id)).not.toContain(0);
    });

    it("keeps two different cards' tool logs independent", () => {
        const { result } = renderFeed();

        act(() => latestSource().emit('card', wireEvent({ correlationId: '0001', message: 'tool.executed' })));
        act(() => latestSource().emit('card', wireEvent({ correlationId: '0002', message: 'tool.denied' })));

        expect(result.current.toolLog['0001']).toHaveLength(1);
        expect(result.current.toolLog['0002']).toHaveLength(1);
        expect(result.current.toolLog['0001']![0]!.type).toBe('tool.executed');
    });
});

describe('useCardFeed activity/toolLog reset', () => {
    it('clears activity and toolLog when the project changes, rather than carrying a stale card forward', () => {
        const { result, rerender } = renderFeed('first-project');

        act(() => latestSource().emit('card', wireEvent({ correlationId: '0043', message: 'tool.executed' })));
        expect(result.current.activity['0043']).toBeDefined();
        expect(result.current.toolLog['0043']).toBeDefined();

        rerender({ project: 'second-project' });

        expect(result.current.activity).toEqual({});
        expect(result.current.toolLog).toEqual({});
    });

    it('clears activity and toolLog on reconnect', () => {
        const { result } = renderFeed();

        act(() => latestSource().emit('card', wireEvent({ correlationId: '0043', message: 'tool.executed' })));
        expect(result.current.activity['0043']).toBeDefined();

        act(() => result.current.reconnect());

        expect(result.current.activity).toEqual({});
        expect(result.current.toolLog).toEqual({});
    });
});

describe('useCardFeed shared clock (now)', () => {
    it('ticks roughly every ten seconds, without opening a second EventSource (AC7)', () => {
        vi.useFakeTimers();
        const { result } = renderFeed();
        const before = result.current.now.getTime();

        act(() => {
            vi.advanceTimersByTime(10_000);
        });

        expect(result.current.now.getTime()).toBeGreaterThan(before);
        expect(FakeEventSource.instances).toHaveLength(1);
    });

    it('does not tick before ten seconds have passed', () => {
        vi.useFakeTimers();
        const { result } = renderFeed();
        const before = result.current.now.getTime();

        act(() => {
            vi.advanceTimersByTime(9_000);
        });

        expect(result.current.now.getTime()).toBe(before);
    });
});
