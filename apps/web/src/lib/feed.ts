import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE } from './sdk.js';

/** Whether the board is watching the live feed or showing whatever it last fetched. */
export type FeedStatus = 'live' | 'disconnected';

/**
 * Subscribes to `/api/feed` for the lifetime of the app and invalidates the cards query on every
 * event, so a card that moves shows up without anyone pressing refresh.
 *
 * Deliberately not a reducer that folds events into board state: the feed hands a fresh subscriber
 * the latest value per card on connect, so replaying the stream client-side would just rebuild what
 * the snapshot already gives for free. An event only ever means "go re-fetch the list" — the runner
 * is the sole writer, and rendering a client-side guess at the next state would render a lie.
 *
 * Reconnection needs no code of its own: a plain `EventSource` retries on its own after the
 * connection drops (an API restart, most likely, since every restart drops every open stream), and
 * `onopen`/`onerror` are enough to track whether that retry has landed yet.
 *
 * `project`, card 0153: `EventSource` cannot set `X-Wilson-Project`, so a project-scoped screen names
 * itself with `?project=` instead — the query fallback `routes.setup.ts`'s `ProjectContextRouter` now
 * accepts for exactly this reason. Left `undefined` (the default, from `__root.tsx` on every screen
 * that carries no `project` route param) the connection names none, resolving to the daemon's own
 * configured project exactly as it did before this card.
 *
 * Card 0154: the connection already names its project (above), so the server only ever delivers this
 * subscriber events for that one project (`FeedRouter`'s own `filter = { source: project }` in
 * `routes.setup.ts`) — but invalidating a fixed `['cards']` regardless would still miss the board
 * that is actually on screen. A `/projects/$project` screen (`projects.$project.index.tsx`) reads
 * `['project', project, 'cards']`, prefixed so its cache can never collide with another project's own
 * — invalidating that same key is what makes an event on screen actually refetch that screen's board,
 * and never another project's.
 *
 * The plain `['cards']` key is invalidated too, unconditionally, alongside the scoped one: card 0155
 * deleted the last route that read it as a board of its own (the top-level `/`), but `FlaggedIndicator`
 * (`__root.tsx`'s shared header) still reads it through the unscoped singleton client, on every screen,
 * regardless of which project is on screen — its own doc comment defers giving it a project-scoped
 * cache key to a later card. Dropping the plain-key invalidation here when a project is given would
 * silently break that badge's live count on every project-scoped screen, which this card's own
 * acceptance criteria rules out ("every screen behaves exactly as it does today"). Invalidating it
 * doesn't reopen the bug above: nothing left reads the plain key as a *board*, only this one
 * project-agnostic widget.
 */
export const useCardFeed = (project?: string): FeedStatus => {
    const queryClient = useQueryClient();
    const [status, setStatus] = useState<FeedStatus>('disconnected');

    useEffect(() => {
        const url = project ? `${API_BASE}/api/feed?project=${encodeURIComponent(project)}` : `${API_BASE}/api/feed`;
        const source = new EventSource(url);
        const cardsQueryKey = project ? ['project', project, 'cards'] : ['cards'];

        source.onopen = () => setStatus('live');
        source.onerror = () => setStatus('disconnected');
        source.addEventListener('card', () => {
            void queryClient.invalidateQueries({ queryKey: cardsQueryKey });
            if (project) void queryClient.invalidateQueries({ queryKey: ['cards'] });
        });

        return () => source.close();
    }, [queryClient, project]);

    return status;
};
