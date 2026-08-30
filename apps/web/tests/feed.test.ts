// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCardFeed } from '#src/lib/feed.js';
import { API_BASE } from '#src/lib/sdk.js';

/**
 * A stand-in for the browser's `EventSource`. jsdom does not implement it, and mocking the real
 * one would just be testing the mock — this records what the hook does to it (the URL it opened,
 * the listeners it registered) and lets a test drive `onopen`/`onerror`/`card` exactly as the
 * browser would.
 */
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

    /** Fires every listener registered for `type`, as the real EventSource would on a message. */
    emit(type: string, data = '') {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(new MessageEvent(type, { data }));
        }
    }
}

const latestSource = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];

beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const renderFeed = (project?: string) => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);
    const hook = renderHook(({ project: p }: { project?: string }) => useCardFeed(p), { wrapper, initialProps: { project } });
    return { ...hook, invalidateQueries };
};

describe('useCardFeed', () => {
    it('opens a single EventSource against the feed endpoint', () => {
        renderFeed();
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(latestSource().url).toBe(`${API_BASE}/api/feed`);
    });

    it('reports disconnected until the stream actually opens', () => {
        const { result } = renderFeed();
        expect(result.current).toBe('disconnected');
    });

    it('flips to live once the connection opens', () => {
        const { result } = renderFeed();

        act(() => latestSource().onopen?.());

        expect(result.current).toBe('live');
    });

    it('drops back to disconnected on error, so a restart shows up rather than staying silent', () => {
        const { result } = renderFeed();

        act(() => latestSource().onopen?.());
        expect(result.current).toBe('live');

        act(() => latestSource().onerror?.());
        expect(result.current).toBe('disconnected');
    });

    it('recovers to live once the browser reconnects after the error', () => {
        const { result } = renderFeed();

        act(() => latestSource().onopen?.());
        act(() => latestSource().onerror?.());
        act(() => latestSource().onopen?.());

        expect(result.current).toBe('live');
    });

    it('invalidates the cards query on a card event, instead of patching state from the payload', () => {
        const { invalidateQueries } = renderFeed();

        act(() => latestSource().emit('card', '{"id":"0043"}'));

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['cards'] });
    });

    it('does not invalidate anything before a card event has arrived', () => {
        const { invalidateQueries } = renderFeed();

        act(() => latestSource().onopen?.());

        expect(invalidateQueries).not.toHaveBeenCalled();
    });

    it('closes the source on unmount instead of leaking an open connection', () => {
        const { unmount } = renderFeed();
        const source = latestSource();

        expect(source.closed).toBe(false);
        unmount();
        expect(source.closed).toBe(true);
    });

    // Card 0153: `EventSource` cannot set `X-Wilson-Project`, so a project-scoped screen names
    // itself with `?project=` instead — the query fallback `routes.setup.ts`'s `ProjectContextRouter`
    // now accepts for exactly this reason.
    it('names the project as a ?project= query parameter when one is given', () => {
        renderFeed('demo-project');
        expect(latestSource().url).toBe(`${API_BASE}/api/feed?project=demo-project`);
    });

    it('url-encodes a project name that needs it, rather than embedding it raw in the query string', () => {
        renderFeed('needs encoding/slash');
        expect(latestSource().url).toBe(`${API_BASE}/api/feed?project=needs%20encoding%2Fslash`);
    });

    it('still opens against the plain feed endpoint, with no query at all, when no project is given', () => {
        renderFeed(undefined);
        expect(latestSource().url).toBe(`${API_BASE}/api/feed`);
    });

    it('closes the previous connection and opens a fresh one naming the new project when the project changes', () => {
        const { rerender } = renderFeed('first-project');
        const first = latestSource();
        expect(first.url).toBe(`${API_BASE}/api/feed?project=first-project`);

        rerender({ project: 'second-project' });

        expect(first.closed).toBe(true);
        expect(FakeEventSource.instances).toHaveLength(2);
        expect(latestSource().url).toBe(`${API_BASE}/api/feed?project=second-project`);
    });
});
