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

    /** Fires every listener registered for `type`, as the real EventSource would on a message. The
     * default `'{}'` is valid JSON with no `message` — card 0274's `useCardFeed` now parses a `card`
     * event's `data` (`WireCardEvent`) before doing anything with it, so an empty string here would
     * silently drop the event instead of exercising the "any card event invalidates" rule below. */
    emit(type: string, data = '{}') {
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
        expect(result.current.status).toBe('disconnected');
    });

    it('flips to live once the connection opens', () => {
        const { result } = renderFeed();

        act(() => latestSource().onopen?.());

        expect(result.current.status).toBe('live');
    });

    it('drops back to disconnected on error, so a restart shows up rather than staying silent', () => {
        const { result } = renderFeed();

        act(() => latestSource().onopen?.());
        expect(result.current.status).toBe('live');

        act(() => latestSource().onerror?.());
        expect(result.current.status).toBe('disconnected');
    });

    it('recovers to live once the browser reconnects after the error', () => {
        const { result } = renderFeed();

        act(() => latestSource().onopen?.());
        act(() => latestSource().onerror?.());
        act(() => latestSource().onopen?.());

        expect(result.current.status).toBe('live');
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

    // Card 0154: an unscoped subscriber still invalidates the plain `['cards']` key, exactly as
    // before this card — `/`'s own board (and the shared header, `FlaggedIndicator`) reads that key.
    it('invalidates the plain cards query, not a project-scoped one, when no project is given', () => {
        const { invalidateQueries } = renderFeed(undefined);

        act(() => latestSource().emit('card'));

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['cards'] });
        expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: expect.arrayContaining(['project']) });
    });

    // Card 0154: a `/projects/$project` screen reads `['project', project, 'cards']`
    // (`projects.$project.index.tsx`), not the plain `['cards']` key — invalidating only the plain
    // key, as this hook did before this card, left that screen's own cache untouched, which is
    // exactly the bug this card fixes (a project-scoped board never actually refetched on its own
    // feed's events).
    it('invalidates the project-scoped cards query when a project is given', () => {
        const { invalidateQueries } = renderFeed('demo-project');

        act(() => latestSource().emit('card'));

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['project', 'demo-project', 'cards'] });
    });

    // The plain `['cards']` key is invalidated too, alongside the scoped one: `FlaggedIndicator`
    // (the shared header's "needs human" count) still reads it through the unscoped singleton client
    // on every screen, project-scoped or not (`feed.ts`'s own doc comment explains why dropping this
    // would silently break that badge's live update on every `/projects/$project` screen).
    it('also invalidates the plain cards query when a project is given, so the shared header stays live', () => {
        const { invalidateQueries } = renderFeed('demo-project');

        act(() => latestSource().emit('card'));

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['cards'] });
    });

    // The regression this card fixes: two screens for two different projects sharing one
    // QueryClient (as they would in the real app — TanStack Query's cache is process-wide, not
    // per-hook). Before this card, every subscriber invalidated the same `['cards']` key regardless
    // of project, so project A's event would mark project B's board stale too. Seeding project B's
    // cache entry as fresh and firing only project A's feed proves that no longer happens.
    it('does not mark another project\'s cache entry stale when this project\'s feed fires an event', () => {
        const queryClient = new QueryClient();
        queryClient.setQueryData(['project', 'project-b', 'cards'], []);
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
        const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);

        renderHook(() => useCardFeed('project-a'), { wrapper });
        const [sourceA] = FakeEventSource.instances;

        act(() => sourceA.emit('card'));

        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['project', 'project-a', 'cards'] });
        expect(invalidateQueries).not.toHaveBeenCalledWith({ queryKey: ['project', 'project-b', 'cards'] });
        expect(queryClient.getQueryState(['project', 'project-b', 'cards'])?.isInvalidated).toBeFalsy();
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

    // Card 0173: `reconnect` is the header's refresh affordance — not optimistic anything (this
    // card's Constraints), so it invalidates every query rather than guessing at what changed.
    describe('reconnect', () => {
        it('invalidates every query, not just the cards key', () => {
            const { result, invalidateQueries } = renderFeed();

            act(() => result.current.reconnect());

            expect(invalidateQueries).toHaveBeenCalledWith();
        });

        it('closes the current connection and opens a fresh one', () => {
            const { result } = renderFeed();
            const first = latestSource();

            act(() => result.current.reconnect());

            expect(first.closed).toBe(true);
            expect(FakeEventSource.instances).toHaveLength(2);
            expect(latestSource()).not.toBe(first);
        });

        it('drops the status back to disconnected immediately, rather than showing live until the new source errors', () => {
            const { result } = renderFeed();
            act(() => latestSource().onopen?.());
            expect(result.current.status).toBe('live');

            act(() => result.current.reconnect());

            expect(result.current.status).toBe('disconnected');
        });

        it('flips back to live once the fresh connection opens', () => {
            const { result } = renderFeed();
            act(() => latestSource().onopen?.());

            act(() => result.current.reconnect());
            act(() => latestSource().onopen?.());

            expect(result.current.status).toBe('live');
        });
    });
});
