// @vitest-environment jsdom
//
// More `useCardFeed` coverage, split from feed.test.ts: per-mount isolation and repeated events,
// as opposed to that file's single-connection lifecycle (open, status transitions, one invalidate).
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCardFeed } from '#src/lib/feed.js';

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

const renderFeed = () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);
    const hook = renderHook(() => useCardFeed(), { wrapper });
    return { ...hook, invalidateQueries };
};

describe('useCardFeed', () => {
    it('invalidates once per card event, not just on the first', () => {
        const { invalidateQueries } = renderFeed();
        const source = FakeEventSource.instances[0];

        act(() => source.emit('card'));
        act(() => source.emit('card'));
        act(() => source.emit('card'));

        expect(invalidateQueries).toHaveBeenCalledTimes(3);
    });

    it('opens a fresh connection on remount rather than reusing the closed one', () => {
        const { unmount } = renderFeed();
        expect(FakeEventSource.instances).toHaveLength(1);

        unmount();
        renderFeed();

        expect(FakeEventSource.instances).toHaveLength(2);
        expect(FakeEventSource.instances[0].closed).toBe(true);
        expect(FakeEventSource.instances[1].closed).toBe(false);
    });

    it('keeps two mounted subscribers independent — one going live does not flip the other', () => {
        const first = renderFeed();
        const second = renderFeed();

        act(() => FakeEventSource.instances[0].onopen?.());

        expect(first.result.current).toBe('live');
        expect(second.result.current).toBe('disconnected');
    });
});
